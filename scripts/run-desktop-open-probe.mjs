#!/usr/bin/env node
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, readlinkSync} from "node:fs";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const DEFAULT_PROJECT = fileURLToPath(new URL("../测试项目", import.meta.url));
const OUTPUT_LIMIT = 16 * 1024;
const HELP = `Usage: node scripts/run-desktop-open-probe.mjs --binary PATH --output PATH [--project PATH] [--config-dir PATH]

Starts one real Tauri GUI probe binary; it does not build, mock native calls, or modify the project.
Requires an already-running static frontend server configured for the probe binary. This is a
desktop measurement launcher, not the JavaScript model benchmark in measure-project-open.mjs.

--binary PATH      Required path to the externally prepared Tauri probe executable.
--project PATH     Project to open (default: ${DEFAULT_PROJECT}).
--output PATH      Required JSON report path; published only after a fresh report validates.
--config-dir PATH  Isolated app config directory (default: a new directory under the OS temp dir).
--help             Show this help.
`;

let activeChild = null, activeKillTimer = null;
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help") return {help: true};
    if (!["--binary", "--project", "--output", "--config-dir"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${key}\n\n${HELP}`);
    }
    options[key] = args[++i];
  }
  if (!options["--binary"] || !options["--output"]) throw new Error(`--binary and --output are required.\n\n${HELP}`);
  return {binary: resolve(options["--binary"]), project: resolve(options["--project"] ?? DEFAULT_PROJECT),
    output: resolve(options["--output"]), configDir: options["--config-dir"] ? resolve(options["--config-dir"]) : null};
}
function canonicalCandidate(path) {
  let current = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(current), ...suffix); }
    catch {
      try {
        if (lstatSync(current).isSymbolicLink()) { current = resolve(dirname(current), readlinkSync(current)); continue; }
      } catch {}
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve path: ${path}`);
      suffix.unshift(basename(current)); current = parent;
    }
  }
}
function assertOutsideProject(label, path, projectRoot) {
  const candidate = canonicalCandidate(path);
  const rel = relative(projectRoot, candidate);
  const inside = rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (inside) {
    throw new Error(`${label} must resolve outside the project directory: ${candidate}`);
  }
}
function tail(path) {
  try { return readFileSync(path, "utf8").slice(-8_000); } catch { return "(no progress log found)"; }
}
function countRounds(report) {
  const candidates = [report.frontend?.rounds, report.frontend?.runs, report.frontend?.measurements, report.rounds, report.measurements];
  const value = candidates.find(item => Array.isArray(item) || Number.isInteger(item));
  return Array.isArray(value) ? value.length : value;
}
const readName = name => /read/i.test(name) && /(store|project|file)/i.test(name);
const listName = name => /list/i.test(name) && /(store|project|directory)/i.test(name);
const mutatingName = name => /(?:^|[._])(?:write|create|save|delete|remove|rename|move)(?:[._]|$)/i.test(name);
const actionName = item => String(typeof item === "string" ? item : item?.command ?? item?.action ?? item?.name ?? "");
const metricCount = value => typeof value === "number" ? value : value?.count ?? value?.calls;
function nativeCounts(actions, commands) {
  let reads = 0, lists = 0, hasRead = false, hasList = false;
  const consume = (name, value, commandRecord = false) => {
    const count = metricCount(value) ?? (commandRecord ? 1 : undefined);
    if (!Number.isFinite(count)) return;
    if (readName(name)) { reads += count; hasRead = true; }
    if (listName(name)) { lists += count; hasList = true; }
  };
  if (Array.isArray(actions)) for (const item of actions) consume(actionName(item), item);
  else if (actions && typeof actions === "object") for (const [name, value] of Object.entries(actions)) consume(name, value);
  if (!hasRead || !hasList) {
    let commandReads = 0, commandLists = 0, sawRead = false, sawList = false;
    if (Array.isArray(commands)) for (const item of commands) {
      const name = actionName(item), count = metricCount(item) ?? 1;
      if (readName(name) && Number.isFinite(count)) { commandReads += count; sawRead = true; }
      if (listName(name) && Number.isFinite(count)) { commandLists += count; sawList = true; }
    }
    if (!hasRead && sawRead) { reads = commandReads; hasRead = true; }
    if (!hasList && sawList) { lists = commandLists; hasList = true; }
  }
  return {reads, lists, hasRead, hasList};
}
function writeCommandCount(report) {
  let observed = false, count = 0;
  const sources = [];
  if (Array.isArray(report.nativeCommands)) { sources.push(report.nativeCommands); observed = true; }
  if (Array.isArray(report.frontend?.calls)) { sources.push(report.frontend.calls); observed = true; }
  for (const source of sources) {
    let sourceCount = 0;
    for (const item of source) if (mutatingName(actionName(item))) sourceCount += metricCount(item) ?? 1;
    count = Math.max(count, sourceCount);
  }
  const inspectWriteTelemetry = (value, path = "") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const inGuard = /(?:read|write).?guard/i.test(path);
      const explicitCounter = /(?:write|save|create|delete|remove|rename|move).*(?:count|calls|commands|actions|attempts)|(?:count|calls|commands|actions|attempts).*(?:write|save|create|delete|remove|rename|move)|^writes?$/i.test(key)
        || inGuard && /^(?:count|calls|writes|writeAttempts)$/i.test(key);
      if (typeof child === "number" && Number.isFinite(child) && explicitCounter) {
        observed = true; count = Math.max(count, child);
      } else if (child && typeof child === "object") inspectWriteTelemetry(child, path ? `${path}.${key}` : key);
    }
  };
  inspectWriteTelemetry(report.frontend, "frontend");
  for (const [key, value] of Object.entries(report)) if (/(?:read|write).?guard/i.test(key)) inspectWriteTelemetry(value, key);
  if (Array.isArray(report.nativeActions)) for (const item of report.nativeActions) {
    if (mutatingName(actionName(item))) { observed = true; count = Math.max(count, metricCount(item) ?? 1); }
  }
  else if (report.nativeActions && typeof report.nativeActions === "object") {
    for (const [name, value] of Object.entries(report.nativeActions)) if (mutatingName(name)) {
      observed = true; count = Math.max(count, metricCount(value) ?? 1);
    }
  }
  return {observed, count};
}
function fail(message, progressPath, childOutput = "") {
  process.stderr.write(`Desktop project-open probe failed: ${message}\n`);
  if (childOutput) process.stderr.write(`\n--- child output (limited) ---\n${childOutput}\n`);
  process.stderr.write(`\n--- progress tail: ${progressPath} ---\n${tail(progressPath)}\n`);
  process.exitCode = 1;
}
function signalExitCode(signal) { return signal === "SIGINT" ? 130 : 143; }
function terminateChild(signal) {
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
  try { activeChild.kill(signal); } catch {}
  if (!activeKillTimer) {
    activeKillTimer = setTimeout(() => {
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill("SIGKILL");
    }, 5_000);
    activeKillTimer.unref();
  }
}
function runChild(binary, env) {
  const child = spawn(binary, [], {stdio: ["ignore", "pipe", "pipe"], env});
  activeChild = child;
  let output = "", outputBytes = 0, timedOut = false, parentSignal = null, spawnError = null;
  const capture = (stream, label) => stream.on("data", chunk => {
    const remaining = OUTPUT_LIMIT - outputBytes;
    if (remaining > 0) {
      const tagged = Buffer.concat([Buffer.from(`\n[${label}] `), chunk]).subarray(0, remaining);
      output += tagged.toString("utf8"); outputBytes += tagged.length;
    }
  });
  capture(child.stdout, "stdout"); capture(child.stderr, "stderr");
  const onInterrupt = () => { parentSignal = "SIGINT"; terminateChild("SIGINT"); };
  const onTerminate = () => { parentSignal = "SIGTERM"; terminateChild("SIGTERM"); };
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  return new Promise(resolveResult => {
    let finished = false;
    const timeout = setTimeout(() => { timedOut = true; terminateChild("SIGTERM"); }, 180_000);
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(activeKillTimer); activeKillTimer = null; activeChild = null;
      process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate);
      resolveResult({...result, timedOut, parentSignal, output});
    };
    child.once("error", error => {
      spawnError = error;
      if (!child.pid) finish({error}); else terminateChild("SIGTERM");
    });
    child.once("close", (code, signal) => finish({code, signal, error: spawnError}));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  if (!existsSync(options.binary) || !statSync(options.binary).isFile()) throw new Error(`Binary not found or not a file: ${options.binary}`);
  if (!existsSync(options.project) || !statSync(options.project).isDirectory()) throw new Error(`Project directory not found: ${options.project}`);
  const projectRoot = realpathSync(options.project);
  assertOutsideProject("--output", options.output, projectRoot);
  if (existsSync(options.output) && statSync(options.output).isDirectory()) throw new Error(`--output must name a report file: ${options.output}`);
  if (options.configDir) assertOutsideProject("--config-dir", options.configDir, projectRoot);
  mkdirSync(dirname(options.output), {recursive: true});
  assertOutsideProject("--output", options.output, projectRoot);
  let configDir = options.configDir;
  if (configDir) mkdirSync(configDir, {recursive: true});
  else configDir = mkdtempSync(join(tmpdir(), "lodestory-perf-config-"));
  configDir = realpathSync(configDir);
  assertOutsideProject("--config-dir", configDir, projectRoot);
  const runDir = mkdtempSync(join(dirname(options.output), ".lodestory-desktop-open-"));
  try {
    const reportPath = join(runDir, "report.json"), progressPath = join(runDir, "progress.log");
    assertOutsideProject("temporary report", reportPath, projectRoot);
    assertOutsideProject("progress log", progressPath, projectRoot);
    const result = await runChild(options.binary, {...process.env,
      LODESTORY_PERF_PROJECT: options.project, LODESTORY_PERF_CONFIG_DIR: configDir,
      LODESTORY_PERF_OUTPUT: reportPath, LODESTORY_PERF_PROGRESS: progressPath});
    if (result.error) return fail(`could not start child: ${result.error.message}`, progressPath, result.output);
    if (result.timedOut) return fail("child exceeded 180 seconds (SIGTERM, then SIGKILL after 5 seconds)", progressPath, result.output);
    if (result.parentSignal) {
      fail(`launcher received ${result.parentSignal}; forwarded it to the child`, progressPath, result.output);
      process.exitCode = signalExitCode(result.parentSignal); return;
    }
    let report;
    try { assertOutsideProject("fresh report", reportPath, projectRoot); }
    catch (error) { return fail(error.message, progressPath, result.output); }
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
    catch (error) { return fail(`fresh report is missing or invalid JSON: ${error.message}`, progressPath, result.output); }
    if (!report || typeof report !== "object" || Array.isArray(report)) return fail("fresh report must be a JSON object", progressPath, result.output);
    const timingSummary = report.frontend?.timingSummary ?? report.timingSummary;
    const nativeActions = report.nativeActions;
    const counts = nativeCounts(nativeActions, report.nativeCommands);
    const projectWrites = writeCommandCount(report);
    const problems = [];
    if (result.code !== 0) problems.push(`child exited with code ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
    if (report.frontend?.status !== "success") problems.push(`frontend.status is ${JSON.stringify(report.frontend?.status)}, expected "success"`);
    if (countRounds(report) !== 5) problems.push(`report has ${String(countRounds(report))} rounds, expected 5`);
    if (!timingSummary) problems.push("timingSummary is missing");
    if (!counts.hasRead || counts.reads <= 0) problems.push("native read action count is missing or zero");
    if (!counts.hasList || counts.lists <= 0) problems.push("native directory-list action count is missing or zero");
    if (!projectWrites.observed) problems.push("native command or explicit write telemetry is missing");
    if (projectWrites.count !== 0) problems.push(`project write command count is ${projectWrites.count}, expected 0`);
    if (problems.length) return fail(problems.join("; "), progressPath, result.output);
    try { renameSync(reportPath, options.output); }
    catch (error) { return fail(`validated report could not be published: ${error.message}`, progressPath, result.output); }
    process.stdout.write(`${JSON.stringify({timingSummary, nativeActions, projectWriteCommandCount: projectWrites.count}, null, 2)}\n`);
  } finally { rmSync(runDir, {recursive: true, force: true}); }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
