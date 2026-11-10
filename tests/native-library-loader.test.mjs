import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createSdkLoader} from "./helpers/sdkFixture.mjs";
import {loadAppRuntime} from "./helpers/appRuntimeFixture.mjs";

const sdk = createSdkLoader();
const source = readFileSync(new URL("../src/plugins/native-library-loader/nativeLibraryLoaderPlugin.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
function loadPlugin(timers = {setTimeout, clearTimeout}, sdkLoader = sdk) {
  const exports = {};
  vm.runInNewContext(compiled, {exports, Promise, Error, Map, Set, JSON, Object, Array, ...timers,
    require(name) {
      if (name === "@tauri-apps/api/core") return {isTauri: () => false, invoke: () => {throw new Error("unexpected invoke");}};
      return sdkLoader.requireSdk(name);
    }});
  return exports.createNativeLibraryLoaderPlugin;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, no) => {resolve = ok; reject = no;});
  return {promise, resolve, reject};
}
function setup(options = {}) {
  let loader, participant;
  const calls = [];
  let closes = 0;
  const bridge = {
    async open(entry) {assert.equal(entry, "/trusted/library"); return "library-1";},
    async ready() {if (options.ready) return options.ready();},
    async call(_id, request) {
      const value = JSON.parse(request);
      calls.push(value);
      if (options.call) return options.call(value);
      return JSON.stringify({type: "response", requestId: value.requestId, status: "success", result: value.params});
    },
    async close() {closes++; if (options.close) return options.close(closes);},
  };
  const plugin = (options.factory ?? loadPlugin())(bridge);
  plugin.activate({provide(_key, value) {loader = value;}, onStop(value) {participant = value;}});
  return {loader, participant, plugin, calls, get closes() {return closes;}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = requestId => ({requestId, operation: "ping", schemaVersion: "1.0.0", params: {text: "你好"}});

test("load and call through the public service; stopping waits for in-flight calls", async () => {
  const gate = deferred();
  const f = setup({call: () => gate.promise});
  const instance = await f.loader.load("/trusted/library");
  const call = instance.call(request("one"));
  await tick();
  assert.equal(f.calls[0].type, "call");
  await assert.rejects(instance.call(request("one")), /请求 ID/);
  const closing = f.participant.withdraw();
  await tick();
  assert.equal(f.closes, 0);
  await assert.rejects(instance.call(request("two")), /停止|退出/);
  gate.resolve(JSON.stringify({type: "response", requestId: "one", status: "success", result: {text: "你好"}}));
  assert.deepEqual((await call).result, {text: "你好"});
  await closing;
  assert.equal(f.closes, 1);
  await assert.rejects(f.loader.load("/trusted/library"), /停止/);
});

test("a failed shutdown retains the instance and can be retried", async () => {
  const f = setup({close: attempt => {if (attempt === 1) throw new Error("库仍在保存");}});
  const instance = await f.loader.load("/trusted/library");
  await assert.rejects(f.participant.withdraw(), /库仍在保存/);
  await assert.rejects(instance.call(request("after-failure")), /停止|退出/);
  await f.participant.withdraw();
  assert.equal(f.closes, 2);
});

test("a caller cannot change an already submitted request by mutating its object", async () => {
  const f = setup();
  const instance = await f.loader.load("/trusted/library");
  const input = request("one");
  const result = instance.call(input);
  input.requestId = "two";
  input.params.text = "改变";
  assert.equal((await result).requestId, "one");
  assert.equal(f.calls[0].params.text, "你好");
  await instance.close();
});

test("failed initialization attempts cleanup and retains a failed cleanup for the stop retry", async () => {
  const f = setup({ready: () => {throw new Error("版本不兼容");}, close: attempt => {if (attempt === 1) throw new Error("清理失败");}});
  await assert.rejects(f.loader.load("/trusted/library"), /版本不兼容.*清理未完成.*清理失败/);
  await f.participant.withdraw();
  assert.equal(f.closes, 2);
});

test("a library that finishes initializing during shutdown is cleaned instead of exposed", async () => {
  const gate = deferred();
  const f = setup({ready: () => gate.promise});
  const loading = f.loader.load("/trusted/library");
  await tick();
  const stopping = f.participant.withdraw();
  gate.resolve();
  await assert.rejects(loading, /停止/);
  await stopping;
  assert.equal(f.closes, 1);
});

test("initialization that completes after a shutdown timeout is still cleaned", async () => {
  let nextTimer = 0;
  const timers = new Map();
  const factory = loadPlugin({setTimeout(fn) {const id = ++nextTimer; timers.set(id, fn); return id;}, clearTimeout(id) {timers.delete(id);}});
  const gate = deferred();
  const f = setup({factory, ready: () => gate.promise});
  const loading = f.loader.load("/trusted/library");
  await tick();
  const stopping = f.participant.withdraw();
  [...timers.values()].at(-1)();
  await assert.rejects(stopping, /加载结束超过 30 秒/);
  gate.resolve();
  await assert.rejects(loading, /停止/);
  assert.equal(f.closes, 1);
});

test("a timeout preserves the running close and retry does not close twice", async () => {
  let nextTimer = 0;
  const timers = new Map();
  const gate = deferred();
  const factory = loadPlugin({setTimeout(fn) {const id = ++nextTimer; timers.set(id, fn); return id;}, clearTimeout(id) {timers.delete(id);}});
  const f = setup({factory, close: () => gate.promise});
  const instance = await f.loader.load("/trusted/library");
  const first = instance.close();
  await tick();
  for (const callback of [...timers.values()]) callback();
  timers.clear();
  await assert.rejects(first, /超过 30 秒/);
  const retry = instance.close();
  await tick();
  assert.equal(f.closes, 1);
  gate.resolve();
  await retry;
});

test("invalid responses are reported without losing the library cleanup", async () => {
  const f = setup({call: () => JSON.stringify({type: "response", requestId: "other", status: "success", result: null})});
  const instance = await f.loader.load("/trusted/library");
  await assert.rejects(instance.call(request("one")), /不匹配/);
  await f.plugin.deactivate();
  assert.equal(f.closes, 1);
});

test("a consumer can use a different implementation of the same SDK capability", async () => {
  const f = loadAppRuntime();
  const key = f.requireSdk("@lodestory/sdk/native-library-loader").nativeLibraryLoaderKey;
  const results = [];
  const consumer = {
    id: "consumer", requires: [key], provides: [],
    async activate(context) {
      const backend = await context.get(key).load("/trusted/library");
      results.push((await backend.call(request("one"))).result.text);
      await backend.close();
    },
  };
  const builtIn = loadPlugin(undefined, {requireSdk: name => f.requireSdk(name)})({
    async open() {return "one";}, async ready() {},
    async call(_id, text) {const value = JSON.parse(text); return JSON.stringify({type: "response", requestId: value.requestId, status: "success", result: value.params});},
    async close() {},
  });
  const replacement = {
    id: "replacement-library-loader", requires: [], provides: [key],
    activate(context) {context.provide(key, {async load() {return {
      async call(value) {return {requestId: value.requestId, status: "success", result: value.params};},
      async close() {},
    };}});},
  };
  for (const provider of [builtIn, replacement]) {
    const runtime = await f.createAppRuntime([consumer, provider]);
    await runtime.stop();
  }
  assert.deepEqual(results, ["你好", "你好"]);
});
