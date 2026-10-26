import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {performance} from "node:perf_hooks";

// Model benchmark only. Every project command is served from a pre-read in-memory map;
// write commands are rejected. Source compilation and file pre-reading are outside the timer.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const sourceRoot = resolve(option("--source-root", repository));
const projectPath = resolve(option("--project", resolve(repository, "测试项目")));
const runs = Number(option("--runs", "5"));
assert.ok(Number.isInteger(runs) && runs > 0, "--runs must be a positive integer");

if (!args.includes("--child")) {
  const measurements = [];
  for (let index = 0; index < runs; index++) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", "--source-root", sourceRoot,
      "--project", projectPath], {stdio: ["ignore", "pipe", "inherit"]});
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    await new Promise((done, fail) => {
      child.on("error", fail);
      child.on("exit", code => code === 0 ? done() : fail(new Error(`Measurement exited with ${code}`)));
    });
    const result = JSON.parse(output);
    measurements.push(result);
    process.stderr.write(`Run ${index + 1}/${runs}: open ${result.openResolvedMs.toFixed(1)} ms, complete ${result.allLoadedMs.toFixed(1)} ms\n`);
  }
  const statistics = key => {
    const sorted = measurements.map(item => item[key]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      slowest: sorted.at(-1)};
  };
  const result = {sourceRoot, projectPath, node: process.version, measuredAt: new Date().toISOString(),
    scope: "Fresh JavaScript process per run; source compilation and disk pre-read excluded; native calls and React rendering replaced by startup fixture.",
    summary: {openResolvedMs: statistics("openResolvedMs"), allLoadedMs: statistics("allLoadedMs")}, measurements};
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const destination = option("--output", null);
  if (destination) writeFileSync(resolve(destination), json);
  process.stdout.write(destination ? `${JSON.stringify({output: resolve(destination), summary: result.summary}, null, 2)}\n` : json);
} else {
  const {createMainFixture, flushStartup} = await import(pathToFileURL(resolve(sourceRoot, "tests/helpers/mainStartupFixture.mjs")));
  const implementation = createHash("sha256");
  for (const path of ["src/plugins/asset-management/assetSchemaStore.ts", ...["timelineAxisStore.ts", "timelineEventStore.ts",
    "timelineListFiles.ts", "timelineListModel.ts", "timelinePlugin.tsx"].map(name => `src/plugins/timeline/${name}`)]) {
    implementation.update(path).update("\0").update(readFileSync(resolve(sourceRoot, path)));
  }
  const disk = new Map();
  const directories = [".lodestory/outline-design/timelines", ".lodestory/timeline/axes", ".lodestory/timeline/events"];
  for (const directory of directories) {
    for (const entry of readdirSync(resolve(projectPath, directory), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const path = `${directory}/${entry.name}`;
        disk.set(path, readFileSync(resolve(projectPath, path)));
      }
    }
  }
  disk.set(".lodestory/assets/schema.json", readFileSync(resolve(projectPath, ".lodestory/assets/schema.json")));
  const schema = JSON.parse(disk.get(".lodestory/assets/schema.json").toString("utf8"));
  const expectedEvents = [...disk].filter(([path]) => path.startsWith(".lodestory/timeline/events/"))
    .reduce((sum, [, bytes]) => sum + JSON.parse(bytes.toString("utf8")).events.length, 0);
  const digest = createHash("sha256");
  for (const [path, bytes] of [...disk].sort(([a], [b]) => a.localeCompare(b))) digest.update(path).update("\0").update(bytes);
  const input = {sha256: digest.digest("hex"), files: disk.size,
    timelines: [...disk.keys()].filter(path => path.startsWith(`${directories[0]}/`)).length,
    events: expectedEvents, assets: schema.assets.length, bytes: [...disk.values()].reduce((sum, bytes) => sum + bytes.length, 0)};
  const native = {reads: 0, lists: 0, documentLists: 0, writes: 0};
  const fixture = createMainFixture({
    async invokeHandler(command, values) {
      if (command === "list_documents") { native.documentLists++; return []; }
      assert.equal(values.projectPath, projectPath);
      if (command === "read_project_file") {
        native.reads++;
        assert.ok(disk.has(values.path), `Unexpected read: ${values.path}`);
        return {path: values.path, fileName: values.path.split("/").at(-1), bytes: Array.from(disk.get(values.path))};
      }
      if (command === "list_project_directory") {
        native.lists++;
        const prefix = `${values.path}/`;
        const entries = [...disk].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map(([path, bytes]) => ({path, name: path.slice(prefix.length), kind: "file", size: bytes.length}));
        return {exists: entries.length > 0, entries, issues: []};
      }
      native.writes++;
      throw new Error(`Read-only benchmark rejected command: ${command}`);
    },
  });
  fixture.start();
  await flushStartup();
  const workbench = fixture.getService(fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const timelines = fixture.getService(fixture.requireSdk("@lodestory/sdk/timeline").timelineKey);
  const storage = fixture.getService(fixture.requireSdk("@lodestory/sdk/project-storage").projectStorageKey);
  const catalogs = fixture.getService(fixture.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey);
  assert.ok(workbench && timelines && storage && catalogs, "Startup failed");

  const decodes = {};
  let summaryEventConversions = 0;
  const geometry = fixture.loadModule("plugins/timeline/timelineAxisGeometry.ts");
  const convert = geometry.timelineValueAtOffset;
  geometry.timelineValueAtOffset = (...values) => { summaryEventConversions++; return convert(...values); };
  const decode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (bytes, ...values) {
    const result = decode.call(this, bytes, ...values);
    const format = /"format"\s*:\s*"([^"]+)"/.exec(result)?.[1] ?? "other";
    const count = decodes[format] ??= {calls: 0, bytes: 0};
    count.calls++;
    count.bytes += bytes?.byteLength ?? 0;
    return result;
  };
  let result;
  try {
    const started = performance.now();
    assert.equal(await workbench.openProject({id: "open-benchmark", name: "只读性能测量", path: projectPath}), true);
    const openResolvedMs = performance.now() - started;
    const sessionId = workbench.getSnapshot().session.id;
    const model = timelines.getModel(sessionId);
    const files = storage.getFiles(sessionId);
    const catalog = catalogs.getCatalog(sessionId);
    while (true) {
      const list = model.getSnapshot();
      if (list.loaded && !list.loading && list.entries.length === input.timelines
        && list.entries.reduce((sum, entry) => sum + entry.eventCount, 0) === expectedEvents
        && files.getSnapshot().files.length === input.files && catalog.getSnapshot().assets.length === input.assets) break;
      assert.ok(performance.now() - started < 120_000, "Loading did not finish within 120 seconds");
      await new Promise(done => setImmediate(done));
    }
    await new Promise(done => setImmediate(done));
    const errors = fixture.logs.filter(item => item?.level === "error");
    assert.equal(native.writes, 0, "Benchmark must never write project files");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    result = {implementationSha256: implementation.digest("hex"), input, openResolvedMs, allLoadedMs: performance.now() - started, native, decodes, summaryEventConversions,
      loaded: {timelines: model.getSnapshot().entries.length, events: model.getSnapshot().entries.reduce((sum, entry) => sum + entry.eventCount, 0),
        assets: catalog.getSnapshot().assets.length, periods: model.getSnapshot().entries.map(entry => [entry.id, entry.period])}};
  } finally {
    TextDecoder.prototype.decode = decode;
    geometry.timelineValueAtOffset = convert;
    await fixture.createdCores.at(-1).unmountAll();
  }
  process.stdout.write(JSON.stringify(result));
}
