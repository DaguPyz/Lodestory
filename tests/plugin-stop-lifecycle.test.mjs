import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createSdkLoader} from "./helpers/sdkFixture.mjs";

const root = fileURLToPath(new URL("../src/plugin-core/", import.meta.url));
const modules = new Map();
const sdk = createSdkLoader({modules});
function load(name) {
  const path = resolve(root, name.endsWith(".ts") ? name : `${name}.ts`);
  if (modules.has(path)) return modules.get(path);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const exports = {};
  modules.set(path, exports);
  vm.runInNewContext(compiled, {exports, require(specifier) {
    return specifier.startsWith("@lodestory/sdk") ? sdk.requireSdk(specifier, relative(root, path))
      : load(resolve(dirname(path), specifier));
  }}, {filename: path});
  return exports;
}

const {EngineCore} = load("EngineCore");
const {createServiceKey} = sdk.requireSdk("@lodestory/sdk");

test("checks run before withdrawal; failure preserves the plugin and its dependency", async () => {
  const dependency = createServiceKey("dependency");
  const core = new EngineCore();
  const events = [];
  let allowed = false;
  await core.mount({id: "provider", requires: [], provides: [dependency], activate(ctx) {ctx.provide(dependency, 42);}});
  await core.mount({id: "consumer", requires: [dependency], provides: [], activate(ctx) {
    ctx.onStop({check(scope) {events.push(`check:${scope}`); if (!allowed) throw new Error("busy");},
      withdraw(scope) {events.push(`withdraw:${scope}`); assert.equal(ctx.get(dependency), 42);}});
  }, deactivate() {events.push("deactivate");}});
  await assert.rejects(core.unmount("consumer"), error => error.phase === "check" && error.cause.message === "busy");
  assert.equal(core.isMounted("consumer"), true);
  await assert.rejects(core.unmount("provider"), /required by plugins/);
  assert.deepEqual(events, ["check:plugin"]);
  allowed = true;
  await core.unmount("consumer");
  assert.deepEqual(events, ["check:plugin", "check:plugin", "withdraw:plugin", "deactivate"]);
  await core.unmount("provider");
});

test("failed withdrawal preserves capabilities and a retry does not repeat completed withdrawals", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const events = [];
  let fail = true;
  await core.mount({id: "plugin", requires: [], provides: [service], activate(ctx) {
    ctx.provide(service, 7);
    ctx.onStop({withdraw() {events.push("retry"); if (fail) throw new Error("not clean");}});
    ctx.onStop({withdraw() {events.push("once");}});
  }, deactivate() {events.push("deactivate");}});
  await assert.rejects(core.unmount("plugin"), error => error.phase === "withdraw" && error.cause.message === "not clean");
  assert.equal(core.get(service), 7);
  assert.equal(core.isMounted("plugin"), true);
  fail = false;
  await core.unmount("plugin");
  assert.deepEqual(events, ["once", "retry", "retry", "deactivate"]);
});

test("application stop checks the whole set before withdrawing anything", async () => {
  const core = new EngineCore();
  const events = [];
  let allow = false;
  await core.mount({id: "first", requires: [], provides: [], activate(ctx) {
    ctx.onStop({check(scope) {events.push(`first:${scope}`); if (!allow) throw new Error("blocked");},
      withdraw() {events.push("first:withdraw");}});
  }});
  await core.mount({id: "second", requires: [], provides: [], activate(ctx) {
    ctx.onStop({check(scope) {events.push(`second:${scope}`);}, withdraw() {events.push("second:withdraw");}});
  }});
  await assert.rejects(core.unmountAll(), error => error.pluginId === "first" && error.phase === "check");
  assert.deepEqual(events, ["second:application", "first:application"]);
  assert.equal(core.isMounted("first"), true);
  assert.equal(core.isMounted("second"), true);
  allow = true;
  await core.unmountAll();
  assert.deepEqual(events.slice(-4), ["second:application", "first:application", "second:withdraw", "first:withdraw"]);
});

test("a failed save preparation keeps all plugins active and reruns preparation on retry", async () => {
  const core = new EngineCore();
  const events = [];
  let saved = false;
  await core.mount({id: "storage", requires: [], provides: [], activate(ctx) {
    ctx.onStop({prepare(scope) {events.push(`save:${scope}`); if (!saved) throw new Error("save failed");},
      withdraw() {events.push("withdraw");}});
  }, deactivate() {events.push("deactivate");}});
  await assert.rejects(core.unmountAll(), error => error.phase === "prepare" && error.cause.message === "save failed");
  assert.equal(core.isMounted("storage"), true);
  assert.deepEqual(events, ["save:application"]);
  saved = true;
  await core.unmountAll();
  assert.deepEqual(events, ["save:application", "save:application", "withdraw", "deactivate"]);
});

test("a later withdrawal failure cancels earlier preparation before returning", async () => {
  const core = new EngineCore();
  let locked = false;
  let fail = true;
  await core.mount({id: "owner", requires: [], provides: [], activate(ctx) {
    ctx.onStop({prepare() {locked = true;}, cancel() {locked = false;}, withdrawOrder: 1, withdraw() {locked = false;}});
    ctx.onStop({withdraw() {if (fail) throw new Error("view failed");}});
  }});
  await assert.rejects(core.unmount("owner"), error => error.phase === "withdraw");
  assert.equal(locked, false);
  assert.equal(core.isMounted("owner"), true);
  fail = false;
  await core.unmount("owner");
  assert.equal(locked, false);
});

test("mutating a participant after registration cannot replace its checks", async () => {
  const core = new EngineCore();
  const participant = {check() {throw new Error("blocked");}, withdraw() {assert.fail("not allowed");}};
  await core.mount({id: "owner", requires: [], provides: [], activate(ctx) {ctx.onStop(participant);}});
  participant.check = () => {};
  await assert.rejects(core.unmount("owner"), error => error.phase === "check" && error.cause.message === "blocked");
  assert.equal(core.isMounted("owner"), true);
});
