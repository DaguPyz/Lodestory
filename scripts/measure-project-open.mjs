import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
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
  const templateStoreSource = existsSync(resolve(sourceRoot, "src/plugins/asset-management/assetTemplateStore.ts"))
    ? "src/plugins/asset-management/assetTemplateStore.ts" : "src/plugins/asset-management/assetTypeOrderStore.ts";
  const objectStoreSource = existsSync(resolve(sourceRoot, "src/plugins/asset-management/assetObjectFiles.ts"))
    ? ["src/plugins/asset-management/assetObjectFiles.ts"] : [];
  for (const path of ["src/plugins/asset-management/assetSchemaStore.ts", templateStoreSource, ...objectStoreSource,
    ...["timelineAxisStore.ts", "timelineEventStore.ts", "timelineListFiles.ts", "timelineListModel.ts", "timelinePlugin.tsx"]
      .map(name => `src/plugins/timeline/${name}`)]) {
    implementation.update(path).update("\0").update(readFileSync(resolve(sourceRoot, path)));
  }
  const disk = new Map();
  const directories = [".lodestory/outline-design/timelines", ".lodestory/timeline/axes", ".lodestory/timeline/events",
    ".lodestory/assets", ".lodestory/assets/objects"];
  for (const directory of directories) {
    if (!existsSync(resolve(projectPath, directory))) continue;
    for (const entry of readdirSync(resolve(projectPath, directory), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const path = `${directory}/${entry.name}`;
        disk.set(path, readFileSync(resolve(projectPath, path)));
      }
    }
  }
  const assetPaths = [".lodestory/assets/schema.json", ".lodestory/assets/templates.json", ".lodestory/assets/type-order.json"];
  for (const path of assetPaths) {
    const absolutePath = resolve(projectPath, path);
    if (existsSync(absolutePath)) disk.set(path, readFileSync(absolutePath));
  }
  const objectsDirectory = ".lodestory/assets/objects";
  const absoluteObjectsDirectory = resolve(projectPath, objectsDirectory);
  if (existsSync(absoluteObjectsDirectory)) {
    for (const entry of readdirSync(absoluteObjectsDirectory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const path = `${objectsDirectory}/${entry.name}`;
        disk.set(path, readFileSync(resolve(projectPath, path)));
      }
    }
  }
  const schema = disk.has(".lodestory/assets/schema.json")
    ? JSON.parse(disk.get(".lodestory/assets/schema.json").toString("utf8"))
    : null;
  const templates = disk.has(".lodestory/assets/templates.json")
    ? JSON.parse(disk.get(".lodestory/assets/templates.json").toString("utf8"))
    : schema?.types ?? [];
  assert.ok(Array.isArray(templates), "Asset templates must be a top-level list or legacy schema types array");
  const groupPaths = schema?.schemaVersion === 4
    ? schema.groups.map(id => `${objectsDirectory}/${id ?? "unclassified"}.json`)
    : schema === null
      ? [...templates.map(template => template.id), null]
        .map(id => `${objectsDirectory}/${id ?? "unclassified"}.json`)
        .filter(path => disk.has(path))
      : [];
  const groups = groupPaths.map(path => {
    assert.ok(disk.has(path), `Missing object group: ${path}`);
    return JSON.parse(disk.get(path).toString("utf8"));
  });
  const assets = schema?.schemaVersion === 4 || schema === null
    ? groups.flatMap(group => group.assets ?? [])
    : schema.assets ?? [];
  const expectedEvents = [...disk].filter(([path]) => path.startsWith(".lodestory/timeline/events/"))
    .reduce((sum, [, bytes]) => sum + JSON.parse(bytes.toString("utf8")).events.length, 0);
  const digest = createHash("sha256");
  for (const [path, bytes] of [...disk].sort(([a], [b]) => a.localeCompare(b))) digest.update(path).update("\0").update(bytes);
  const input = {sha256: digest.digest("hex"), files: disk.size,
    timelines: [...disk.keys()].filter(path => path.startsWith(`${directories[0]}/`)).length,
    events: expectedEvents, templates: templates.length, assets: assets.length,
    bytes: [...disk.values()].reduce((sum, bytes) => sum + bytes.length, 0)};
  const expectedTimelineIds = [...disk.keys()].filter(path => path.startsWith(`${directories[0]}/`))
    .map(path => path.slice(path.lastIndexOf("/") + 1, -".json".length));
  const expectedTemplateIds = templates.map(template => template.id);
  const expectedAssetIds = assets.map(asset => asset.id);
  const sameIds = (actual, expected) => actual.length === expected.length && expected.every(id => actual.includes(id));
  const native = {reads: 0, lists: 0, documentLists: 0, writes: 0};
  const fixture = createMainFixture({
    async invokeHandler(command, values) {
      if (command === "list_plugin_packages") return [];
      if (command === "list_documents") { native.documentLists++; return []; }
      assert.equal(values.projectPath, projectPath);
      if (command === "read_project_file" || command === "read_project_file_base64") {
        native.reads++;
        assert.ok(disk.has(values.path), `Unexpected read: ${values.path}`);
        if (command === "read_project_file_base64") {
          const bytes = disk.get(values.path);
          return {path: values.path, fileName: values.path.split("/").at(-1),
            bytesBase64: bytes.toString("base64"), byteLength: bytes.length};
        }
        return {path: values.path, fileName: values.path.split("/").at(-1), bytes: Array.from(disk.get(values.path))};
      }
      if (command === "list_project_directory") {
        native.lists++;
        const prefix = `${values.path}/`;
        const entries = [...disk].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map(([path, bytes]) => ({path, name: path.slice(prefix.length), kind: "file", size: bytes.length}));
        entries.push(...directories.filter(path => path !== values.path && path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map(path => ({path, name: path.slice(prefix.length), kind: "directory", size: null})));
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
    let model = null;
    let files = null;
    let catalog = null;
    while (!model || !files || !catalog) {
      assert.ok(performance.now() - started < 120_000, "Project session services did not become available");
      const startupError = workbench.getSnapshot().loading?.error;
      assert.ok(!startupError, startupError?.message ?? "Project session startup failed");
      model ??= timelines.getModel(sessionId);
      files ??= storage.getFiles(sessionId);
      catalog ??= catalogs.getCatalog(sessionId);
      if (!model || !files || !catalog) await new Promise(done => setImmediate(done));
    }
    while (true) {
      const list = model.getSnapshot();
      const catalogSnapshot = catalog.getSnapshot();
      if (list.loaded && !list.loading && list.entries.length === input.timelines
        && sameIds(list.entries.map(entry => entry.id), expectedTimelineIds)
        && list.entries.reduce((sum, entry) => sum + entry.eventCount, 0) === expectedEvents
        && catalogSnapshot.loaded && !catalogSnapshot.loading
        && catalogSnapshot.types.length === input.templates && sameIds(catalogSnapshot.types.map(type => type.id), expectedTemplateIds)
        && catalogSnapshot.assets.length === input.assets && sameIds(catalogSnapshot.assets.map(asset => asset.id), expectedAssetIds)) break;
      assert.ok(performance.now() - started < 120_000, "Loading did not finish within 120 seconds");
      const startupError = workbench.getSnapshot().loading?.error;
      assert.ok(!startupError, startupError?.message ?? "Project session startup failed");
      await new Promise(done => setImmediate(done));
    }
    await new Promise(done => setImmediate(done));
    const errors = fixture.logs.filter(item => item?.level === "error");
    assert.equal(native.writes, 0, "Benchmark must never write project files");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    result = {implementationSha256: implementation.digest("hex"), input, openResolvedMs, allLoadedMs: performance.now() - started, native, decodes, summaryEventConversions,
      loaded: {timelines: model.getSnapshot().entries.length, events: model.getSnapshot().entries.reduce((sum, entry) => sum + entry.eventCount, 0),
        templates: catalog.getSnapshot().types.length, assets: catalog.getSnapshot().assets.length,
        periods: model.getSnapshot().entries.map(entry => [entry.id, entry.period])}};
  } finally {
    TextDecoder.prototype.decode = decode;
    geometry.timelineValueAtOffset = convert;
    await fixture.createdCores.at(-1).unmountAll();
  }
  process.stdout.write(JSON.stringify(result));
}
