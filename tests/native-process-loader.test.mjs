import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createSdkLoader} from "./helpers/sdkFixture.mjs";

const sdk = createSdkLoader();
const source = readFileSync(new URL("../src/plugins/native-process-loader/nativeProcessLoaderPlugin.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports, Promise, Error, Map, Set, JSON, Object, Array, setTimeout, clearTimeout,
  require(name) {
    if (name === "@tauri-apps/api/core") return {isTauri: () => false, invoke: () => { throw new Error("unexpected invoke"); }};
    return sdk.requireSdk(name);
  }});

function setup() {
  const queue = [], readers = [], writes = [], aborts = [];
  let participant, loader;
  const bridge = {
    async start(entry) { assert.equal(entry, "/trusted/backend"); return "process-1"; },
    read() { return new Promise(resolve => { if (queue.length) resolve(queue.shift()); else readers.push(resolve); }); },
    async write(_id, line) { writes.push(JSON.parse(line)); },
    async wait() { return 0; },
    async abortStart(id) { aborts.push(id); },
  };
  const plugin = exports.createNativeProcessLoaderPlugin(bridge);
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

test("unexpected process output rejects the pending call and prevents successful stop", async () => {
  const f = setup();
  f.push({type: "ready", protocolVersion: "1.0.0"});
  const instance = await f.loader.load("/trusted/backend");
  const call = instance.call({requestId: "1", operation: "x", schemaVersion: "1", params: null});
  f.push(null);
  await assert.rejects(call, /输出已关闭/);
  await assert.rejects(f.participant.withdraw(), /输出已关闭/);
});
