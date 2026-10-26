import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

// These stub-child checks validate launcher safeguards only; they are not desktop performance measurements.
const launcher = fileURLToPath(new URL("../scripts/run-desktop-open-probe.mjs", import.meta.url));
const goodReport = {
  frontend: {status: "success", rounds: [{}, {}, {}, {}, {}], timingSummary: {medianMs: 10}},
  nativeCommands: [{command: "read_project_file"}, {command: "list_project_directory"}],
  nativeActions: {"store.read": {count: 1, totalMs: 2}, "store.list_directory": {count: 1, totalMs: 3}},
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lodestory-open-launcher-test-"));
  const project = join(root, "project");
  mkdirSync(project);
  const binary = join(root, "probe-stub.cjs");
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.STUB_MODE;
if (mode === "wait-for-signal") {
  fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
  process.on("SIGTERM", () => { fs.writeFileSync(process.env.STUB_SIGNAL_FILE, "SIGTERM"); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (mode !== "no-report") {
  const report = ${JSON.stringify(goodReport)};
  if (mode === "no-write-telemetry") { delete report.nativeCommands; }
  if (mode === "native-action-array-write") {
    report.nativeCommands = [];
    report.nativeActions = [
      {command: "store.read", count: 1}, {name: "store.list_directory", count: 1}, {action: "store.save", count: 1},
    ];
  }
  if (mode === "frontend-call-write") {
    report.nativeCommands = [];
    report.frontend.calls = ["save_project_file"];
  }
  fs.writeFileSync(process.env.LODESTORY_PERF_OUTPUT, JSON.stringify(report));
}
`);
  chmodSync(binary, 0o755);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, project, binary, output: join(root, "report.json")};
}

function run(f, mode, extra = []) {
  return spawnSync(process.execPath, [launcher, "--binary", f.binary, "--project", f.project, "--output", f.output, ...extra], {
    encoding: "utf8", env: {...process.env, STUB_MODE: mode}, timeout: 15_000,
  });
}

test("launcher publishes only the fresh validated report from its child", t => {
  const f = fixture(t);
  const result = run(f, "valid");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), goodReport);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["timingSummary", "nativeActions", "projectWriteCommandCount"]);
  assert.equal(JSON.parse(result.stdout).projectWriteCommandCount, 0);
});

test("launcher rejects a stale preexisting report when the child writes no report", t => {
  const f = fixture(t);
  const stale = JSON.stringify(goodReport);
  writeFileSync(f.output, stale);
  const result = run(f, "no-report");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh report is missing/);
  assert.equal(readFileSync(f.output, "utf8"), stale);
});

test("launcher requires explicit write or native-command telemetry", t => {
  const f = fixture(t);
  const result = run(f, "no-write-telemetry");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native command or explicit write telemetry is missing/);
});

test("launcher detects write actions in action arrays and frontend calls", t => {
  const f = fixture(t);
  let result = run(f, "native-action-array-write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /project write command count is 1/);
  result = run(f, "frontend-call-write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /project write command count is 1/);
});

test("launcher rejects output and symlinked config paths that resolve into the project", t => {
  const f = fixture(t);
  let result = spawnSync(process.execPath, [launcher, "--binary", f.binary, "--project", f.project,
    "--output", join(f.project, "report.json")], {encoding: "utf8", timeout: 15_000});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output must resolve outside the project/);
  const projectAlias = join(f.root, "project-alias");
  symlinkSync(f.project, projectAlias, "dir");
  result = spawnSync(process.execPath, [launcher, "--binary", f.binary, "--project", f.project,
    "--output", join(projectAlias, "report.json")], {encoding: "utf8", timeout: 15_000});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output must resolve outside the project/);
  const inside = join(f.project, "config");
  mkdirSync(inside);
  const alias = join(f.root, "config-alias");
  symlinkSync(inside, alias, "dir");
  result = spawnSync(process.execPath, [launcher, "--binary", f.binary, "--project", f.project,
    "--output", f.output, "--config-dir", alias], {encoding: "utf8", timeout: 15_000});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config-dir must resolve outside the project/);
  assert.equal(existsSync(f.output), false);
});

test("launcher forwards SIGTERM and waits for its child to exit", async t => {
  const f = fixture(t);
  const pidFile = join(f.root, "child.pid"), signalFile = join(f.root, "child.signal");
  const child = spawn(process.execPath, [launcher, "--binary", f.binary, "--project", f.project, "--output", f.output], {
    stdio: ["ignore", "pipe", "pipe"], env: {...process.env, STUB_MODE: "wait-for-signal", STUB_PID_FILE: pidFile, STUB_SIGNAL_FILE: signalFile},
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(pidFile), true, "stub child did not start");
  child.kill("SIGTERM");
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({code, signal})));
  assert.equal(result.code, 143);
  assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM");
});
