import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createSdkLoader} from "./helpers/sdkFixture.mjs";

const sdk = createSdkLoader();
const source = readFileSync(new URL("../src/plugins/native-process-loader/nativeProcessLoaderPlugin.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
function loadPlugin(timers = {setTimeout, clearTimeout}) {
  const exports = {};
  vm.runInNewContext(compiled, {exports, Promise, Error, Map, Set, JSON, Object, Array, ...timers,
    require(name) {
      if (name === "@tauri-apps/api/core") return {isTauri: () => false, invoke: () => { throw new Error("unexpected invoke"); }};
      return sdk.requireSdk(name);
    }});
  return exports.createNativeProcessLoaderPlugin;
}
const createPlugin = loadPlugin();

function setup(factory = createPlugin) {
  const queue = [], readers = [], writes = [], aborts = [];
  let participant, loader;
  const bridge = {
    async start(entry) { assert.equal(entry, "/trusted/backend"); return "process-1"; },
    read() { return new Promise(resolve => { if (queue.length) resolve(queue.shift()); else readers.push(resolve); }); },
    async write(_id, line) { writes.push(JSON.parse(line)); },
    async wait() { return 0; },
    async abortStart(id) { aborts.push(id); },
  };
  const plugin = factory(bridge);
  plugin.activate({provide(_key, value) {loader = value;}, onStop(value) {participant = value;}});
  function push(value) { const message = value === null ? null : JSON.stringify(value); const reader = readers.shift(); if (reader) reader(message); else queue.push(message); }
  return {loader, participant, plugin, push, writes, aborts};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("load, correlate out-of-order calls, and stop after pending calls finish", async () => {
  const f = setup();
  f.push({type: "ready", protocolVersion: "1.0.0"});
  const instance = await f.loader.load("/trusted/backend");
  const first = instance.call({requestId: "1", operation: "one", schemaVersion: "1.0.0", params: null});
  const second = instance.call({requestId: "2", operation: "two", schemaVersion: "1.0.0", params: {x: 1}});
  const stop = f.participant.withdraw();
  await tick();
  assert.equal(f.writes.length, 2, "shutdown waits for in-flight requests");
  f.push({type: "response", requestId: "2", status: "error", error: {code: "FAIL", message: "bad"}});
  f.push({type: "response", requestId: "1", status: "success", result: {value: 42}});
  assert.equal((await second).error.code, "FAIL");
  assert.equal((await first).result.value, 42);
  await tick();
  const shutdown = f.writes.at(-1);
  assert.equal(shutdown.type, "shutdown");
  f.push({type: "response", requestId: shutdown.requestId, status: "success", result: null});
  await stop;
  await assert.rejects(instance.call({requestId: "3", operation: "x", schemaVersion: "1", params: null}), /停止|退出/);
});

test("invalid ready cleans the partially started process", async () => {
  const f = setup();
  f.push({type: "ready", protocolVersion: "2.0.0"});
  await assert.rejects(f.loader.load("/trusted/backend"), /协议版本无效/);
  assert.deepEqual(f.aborts, ["process-1"]);
});

test("a backend can reject shutdown and accept a later retry", async () => {
  const f = setup();
  f.push({type: "ready", protocolVersion: "1.0.0"});
  await f.loader.load("/trusted/backend");
  const first = f.participant.withdraw();
  await tick();
  const firstId = f.writes.at(-1).requestId;
  f.push({type: "response", requestId: firstId, status: "error", error: {code: "BUSY", message: "仍在保存"}});
  await assert.rejects(first, /仍在保存/);

  const second = f.participant.withdraw();
  await tick();
  const secondId = f.writes.at(-1).requestId;
  assert.notEqual(secondId, firstId);
  f.push({type: "response", requestId: secondId, status: "success", result: null});
  await second;
});

test("retry after a shutdown timeout waits for the same request", async () => {
  let nextTimer = 0;
  const timers = new Map();
  const factory = loadPlugin({
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const f = setup(factory);
  f.push({type: "ready", protocolVersion: "1.0.0"});
  const instance = await f.loader.load("/trusted/backend");
  const first = instance.close();
  await tick();
  const shutdownId = f.writes.at(-1).requestId;
  for (const callback of [...timers.values()]) callback();
  timers.clear();
  await assert.rejects(first, /超过 30 秒/);

  const retry = instance.close();
  await tick();
  assert.equal(f.writes.filter(message => message.type === "shutdown").length, 1);
  f.push({type: "response", requestId: shutdownId, status: "success", result: null});
  await retry;
});

test("unexpected process output rejects the pending call and prevents successful stop", async () => {
  const f = setup();
  f.push({type: "ready", protocolVersion: "1.0.0"});
  const instance = await f.loader.load("/trusted/backend");
  const call = instance.call({requestId: "1", operation: "x", schemaVersion: "1", params: null});
  f.push(null);
  await assert.rejects(call, /输出已关闭/);
  await assert.rejects(f.participant.withdraw(), /输出已关闭/);
});
