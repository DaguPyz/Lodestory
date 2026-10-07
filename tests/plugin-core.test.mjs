import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/plugin-core/", import.meta.url));
const modules = new Map();

// Follow the existing test convention: compile the TypeScript source without adding a test runtime.
function load(name) {
  const path = resolve(root, name.endsWith(".ts") ? name : `${name}.ts`);
  const cached = modules.get(path);
  if (cached) return cached;
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  modules.set(path, exports);
  vm.runInNewContext(compiled, {
    exports,
    require(specifier) { return load(resolve(dirname(path), specifier)); },
  }, { filename: path });
  return exports;
}

const { EngineCore, PluginActivationError } = load("EngineCore");
const { createServiceKey } = load("ServiceKey");

test("a workflow plugin calls a capability provided by another plugin", async () => {
  const text = createServiceKey("text");
  const workflow = createServiceKey("workflow");
  const core = new EngineCore();
  const stopped = [];

  await core.mount({
    id: "text-provider",
    activate(context) { context.provide(text, { format: (value) => value.toUpperCase() }); },
    deactivate() { stopped.push("text-provider"); },
  });
  await core.mount({
    id: "writing-workflow",
    activate(context) {
      context.provide(workflow, { run: (value) => context.get(text).format(value) });
    },
    deactivate() { stopped.push("writing-workflow"); },
  });

  assert.equal(core.get(workflow).run("Lodestory"), "LODESTORY");
  assert.equal(core.isMounted("writing-workflow"), true);
  await core.unmount("writing-workflow");
  await core.unmount("text-provider");
  assert.deepEqual(stopped, ["writing-workflow", "text-provider"]);
  assert.throws(() => core.get(workflow), /not registered/);
  assert.throws(() => core.get(text), /not registered/);
});

test("duplicate ids and capabilities are rejected without removing the first provider", async () => {
  const service = createServiceKey("shared");
  const partial = createServiceKey("should-not-leak");
  const core = new EngineCore();
  await core.mount({ id: "first", activate(context) { context.provide(service, 42); } });

  await assert.rejects(core.mount({ id: "first", activate() {} }), /already mounted/);
  let cleaned = false;
  await assert.rejects(core.mount({
    id: "second",
    activate(context) {
      context.provide(partial, 99);
      context.provide(service, 99);
    },
    deactivate() { cleaned = true; },
  }), /already registered/);

  assert.equal(cleaned, true);
  assert.equal(core.get(service), 42);
  assert.throws(() => core.get(partial), /not registered/);
  assert.equal(core.isMounted("second"), false);
  await core.unmount("first");
});

test("activation failure rolls back registrations and invokes plugin cleanup", async () => {
  const temporary = createServiceKey("temporary");
  const core = new EngineCore();
  let cleaned = false;
  let retainedContext;
  await assert.rejects(core.mount({
    id: "broken",
    activate(context) {
      retainedContext = context;
      context.provide(temporary, "partial");
      throw new Error("activation failed");
    },
    deactivate() { cleaned = true; },
  }), /activation failed/);

  assert.equal(cleaned, true);
  assert.equal(core.isMounted("broken"), false);
  assert.throws(() => core.get(temporary), /not registered/);
  assert.throws(() => retainedContext.provide(temporary, "late"), /no longer active/);
});

test("failed deactivation still clears services and revokes the old context", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  let retainedContext;
  await core.mount({
    id: "throws-on-stop",
    activate(context) { retainedContext = context; context.provide(service, 1); },
    deactivate() { throw new Error("stop failed"); },
  });

  await assert.rejects(core.unmount("throws-on-stop"), /stop failed/);
  assert.equal(core.isMounted("throws-on-stop"), false);
  assert.throws(() => core.get(service), /not registered/);
  assert.throws(() => retainedContext.get(service), /no longer active/);
});

test("activation and cleanup failures both remain available", async () => {
  const core = new EngineCore();
  await assert.rejects(core.mount({
    id: "double-failure",
    activate() { throw new Error("start failed"); },
    deactivate() { throw new Error("cleanup failed"); },
  }), (error) => {
    assert.ok(error instanceof PluginActivationError);
    assert.match(error.activationError.message, /start failed/);
    assert.match(error.cleanupError.message, /cleanup failed/);
    return true;
  });
});

test("a pending activation cannot be mounted or unloaded twice", async () => {
  const core = new EngineCore();
  const service = createServiceKey("pending-service");
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const mounting = core.mount({ id: "slow", activate(context) {
    context.provide(service, "ready later");
    return pending;
  } });
  assert.throws(() => core.get(service), /not registered/);
  await assert.rejects(core.mount({ id: "slow", activate() {} }), /changing state/);
  await assert.rejects(core.unmount("slow"), /changing state/);
  complete();
  await mounting;
  assert.equal(core.isMounted("slow"), true);
  assert.equal(core.get(service), "ready later");
  await core.unmount("slow");
});
