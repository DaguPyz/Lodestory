#!/usr/bin/env node
import {cp, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROJECT = join(repository, "测试项目");
const FIXTURE_TIMELINES = 26;
const FIXTURE_EVENTS = 2158;
const HELP = `Usage: node scripts/prepare-desktop-open-probe.mjs [--project PATH] [--help]

Prepares an isolated copy of the current src-tauri native sources and applies the
checked desktop measurement patch. It never builds, starts a GUI, or runs a measurement.

The probe is calibrated for the repository's current 测试项目 fixture: 26 timelines,
2,158 events, including the titles 00 · 全书关键剧情 and 01 · 原文细读 0001—0100.
It also expects every displayed timeline period to be resolved. The WebView must load
the current production dist snapshot through a static server at 127.0.0.1:1420.
The final probe omits the uninformative 'timeline-event-label' wrapper count; its visible
'timeline-event-title' readiness check and event-title count are unchanged.

--project PATH  Project fixture to validate (default: ${DEFAULT_PROJECT}).
--help          Show this help.

Native files are copied from the current checkout, then patched with git apply --check.
If those files drift, preparation stops instead of overlaying stale native sources.
The patch excludes Cargo.lock; an offline Cargo build may add the cached direct objc2-app-kit
dependency to the temporary lockfile. SDK and repository native source files are not changed.
`;

function parseArgs(args) {
  let project = DEFAULT_PROJECT;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--help") return {help: true};
    if (option === "--project" && args[index + 1] && !args[index + 1].startsWith("--")) {
      project = resolve(args[++index]);
      continue;
    }
    throw new Error(`Invalid or incomplete option: ${option}\n\n${HELP}`);
  }
  return {project};
}

async function validateFixture(project) {
  const timelineDir = join(project, ".lodestory/outline-design/timelines");
  const eventDir = join(project, ".lodestory/timeline/events");
  const timelineFiles = (await readdir(timelineDir)).filter(name => name.endsWith(".json"));
  const timelines = await Promise.all(timelineFiles.map(async name =>
    JSON.parse(await readFile(join(timelineDir, name), "utf8"))));
  const eventCounts = await Promise.all(timelines.map(async timeline => {
    const events = JSON.parse(await readFile(join(eventDir, `${timeline.id}.json`), "utf8"));
    return events.events.length;
  }));
  const eventCount = eventCounts.reduce((sum, count) => sum + count, 0);
  const titles = new Set(timelines.map(timeline => timeline.title));
  if (timelines.length !== FIXTURE_TIMELINES || eventCount !== FIXTURE_EVENTS
      || !titles.has("00 · 全书关键剧情") || !titles.has("01 · 原文细读 0001—0100")) {
    throw new Error(`Fixture mismatch: found ${timelines.length} timelines and ${eventCount} events; expected ${FIXTURE_TIMELINES} and ${FIXTURE_EVENTS} with the probe titles.`);
  }
  return {timelines: timelines.length, events: eventCount};
}

function applyPatch(workspace, patchPath) {
  for (const args of [["apply", "--check", patchPath], ["apply", patchPath]]) {
    const result = spawnSync("git", args, {cwd: workspace, encoding: "utf8"});
    if (result.error || result.status !== 0) {
      throw new Error(`git apply ${args[1] === "--check" ? "--check " : ""}failed:\n${result.stderr || result.error?.message || result.stdout}`);
    }
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  await stat(options.project);
  const fixture = await validateFixture(options.project);
  const temporary = await mkdtemp(join(tmpdir(), "lodestory-desktop-open-probe-"));
  const workspace = join(temporary, "workspace");
  const tauri = join(workspace, "src-tauri");
  await mkdir(tauri, {recursive: true});
  for (const directory of ["src", "capabilities", "icons"]) {
    await cp(join(repository, "src-tauri", directory), join(tauri, directory), {recursive: true});
  }
  for (const file of ["Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json"]) {
    await copyFile(join(repository, "src-tauri", file), join(tauri, file));
  }

  const patchPath = join(repository, "scripts/fixtures/desktop-open-probe.patch");
  applyPatch(workspace, patchPath);

  const configPath = join(tauri, "tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const appData = join(temporary, "app-data");
  await mkdir(appData, {recursive: true});
  config.build.devUrl = "http://127.0.0.1:1420";
  config.app.appDirectoriesOverride = appData;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const manifest = join(tauri, "Cargo.toml");
  const targetDir = join(repository, "src-tauri/target");
  const binary = join(targetDir, "debug/lodestory-desktop-perf");
  const report = join(temporary, "desktop-open-report.json");
  const staticServer = `python3 -m http.server 1420 --bind 127.0.0.1 --directory ${quote(join(repository, "dist"))}`;
  const compile = `cargo build --offline --manifest-path ${quote(manifest)} --target-dir ${quote(targetDir)} --bin lodestory-desktop-perf`;
  const launch = `node ${quote(join(repository, "scripts/run-desktop-open-probe.mjs"))} --binary ${quote(binary)} --output ${quote(report)} --project ${quote(options.project)}`;
  process.stdout.write(`${JSON.stringify({
    workspace,
    manifest,
    project: options.project,
    fixture,
    staticServer,
    compile,
    launch,
    notes: [
      "Start the static server against the current production dist before launching the Tauri probe.",
      "The prepare command did not compile or start a GUI; launch is printed for a separate, explicit step.",
      "Temporary Cargo.lock changes from an offline build stay inside this temporary workspace.",
    ],
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
