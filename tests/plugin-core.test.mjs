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

const { EngineCore, PluginActivationError, PluginBatchActivationError } = load("EngineCore");
const { createServiceKey } = load("ServiceKey");

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("capability declarations accept different service types and preserve context types", () => {
  const fixture = fileURLToPath(new URL("./fixtures/plugin-core.ts", import.meta.url));
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")).join("\n"), "");
});

test("a workflow plugin calls a capability provided by another plugin", async () => {
  const text = createServiceKey("text");
  const workflow = createServiceKey("workflow");
  const core = new EngineCore();
  const stopped = [];

  await core.mount({
    id: "text-provider",
    requires: [],
    provides: [text],
    activate(context) { context.provide(text, { format: (value) => value.toUpperCase() }); },
    deactivate() { stopped.push("text-provider"); },
  });
  await core.mount({
    id: "writing-workflow",
    requires: [text],
    provides: [workflow],
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
  await core.mount({ id: "first", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });

  await assert.rejects(core.mount({ id: "first", requires: [], provides: [], activate() {} }), /already mounted/);
  let cleaned = false;
  await assert.rejects(core.mount({
    id: "second",
    requires: [],
    provides: [partial, service],
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
    requires: [],
    provides: [temporary],
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
  const dependency = createServiceKey("dependency");
  const core = new EngineCore();
  await core.mount({ id: "provider", requires: [], provides: [dependency], activate(context) { context.provide(dependency, 42); } });
  let retainedContext;
  await core.mount({
    id: "throws-on-stop",
    requires: [dependency],
    provides: [service],
    activate(context) { retainedContext = context; context.provide(service, 1); },
    deactivate() { throw new Error("stop failed"); },
  });

  await assert.rejects(core.unmount("throws-on-stop"), /stop failed/);
  assert.equal(core.isMounted("throws-on-stop"), false);
  assert.throws(() => core.get(service), /not registered/);
  assert.throws(() => retainedContext.get(service), /no longer active/);
  await core.unmount("provider");
});

test("activation and cleanup failures both remain available", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  await assert.rejects(core.mount({
    id: "double-failure",
    requires: [service],
    provides: [],
    activate() { throw new Error("start failed"); },
    deactivate() { throw new Error("cleanup failed"); },
  }), (error) => {
    assert.ok(error instanceof PluginActivationError);
    assert.match(error.activationError.message, /start failed/);
    assert.match(error.cleanupError.message, /cleanup failed/);
    return true;
  });
  await core.unmount("provider");
});

test("a pending activation cannot be mounted or unloaded twice", async () => {
  const core = new EngineCore();
  const service = createServiceKey("pending-service");
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const mounting = core.mount({ id: "slow", requires: [], provides: [service], activate(context) {
    context.provide(service, "ready later");
    return pending;
  } });
  assert.throws(() => core.get(service), /not registered/);
  await assert.rejects(core.mount({ id: "slow", requires: [], provides: [], activate() {} }), /changing state/);
  await assert.rejects(core.unmount("slow"), /changing state/);
  complete();
  await mounting;
  assert.equal(core.isMounted("slow"), true);
  assert.equal(core.get(service), "ready later");
  await core.unmount("slow");
});

test("requires and provides must both be explicit arrays", async () => {
  const core = new EngineCore();
  let activated = false;
  let cleaned = false;
  for (const declarations of [{ requires: [] }, { provides: [] }, { requires: null, provides: [] }, { requires: [], provides: "service" }]) {
    await assert.rejects(core.mount({
      id: "invalid",
      ...declarations,
      activate() { activated = true; },
      deactivate() { cleaned = true; },
    }), /Plugin 'invalid' must declare '(requires|provides)' as an array/);
  }
  assert.equal(activated, false);
  assert.equal(cleaned, false);
  await core.mount({ id: "invalid", requires: [], provides: [], activate() {} });
  await core.unmount("invalid");
});

test("duplicate capabilities in either declaration are rejected before activation", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  for (const field of ["requires", "provides"]) {
    await assert.rejects(core.mount({
      id: "duplicate",
      requires: [],
      provides: [],
      [field]: [service, service],
      activate() { assert.fail("Invalid declarations must not activate."); },
    }), new RegExp(`Plugin 'duplicate' declares service 'service' more than once in '${field}'`));
  }
});

test("missing dependencies prevent activation and the plugin can retry once they are available", async () => {
  const service = createServiceKey("dependency");
  const sameName = createServiceKey("dependency");
  const core = new EngineCore();
  let activated = false;
  let cleaned = false;
  const consumer = {
    id: "consumer",
    requires: [service],
    provides: [],
    activate(context) { activated = true; assert.equal(context.get(service), 42); },
    deactivate() { cleaned = true; },
  };
  await core.mount({ id: "other-key", requires: [], provides: [sameName], activate(context) { context.provide(sameName, 99); } });
  await assert.rejects(core.mount(consumer), /Plugin 'consumer' requires service 'dependency', which is not registered/);
  assert.equal(activated, false);
  assert.equal(cleaned, false);
  assert.equal(core.isMounted("consumer"), false);
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  await core.mount(consumer);
  assert.equal(activated, true);
  await core.unmount("other-key");
  await core.unmount("consumer");
  await core.unmount("provider");
});

test("undeclared get and provide calls fail activation without changing existing capabilities", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  for (const operation of ["get", "provide"]) {
    let cleaned = false;
    await assert.rejects(core.mount({
      id: "undeclared",
      requires: [],
      provides: [],
      activate(context) { context[operation](service, 99); },
      deactivate() { cleaned = true; },
    }), new RegExp(`Plugin 'undeclared' cannot ${operation} undeclared service 'service'`));
    assert.equal(cleaned, true);
    assert.equal(core.get(service), 42);
    assert.equal(core.isMounted("undeclared"), false);
  }
  await core.unmount("provider");
});

test("context permits declared dependencies and own capabilities throughout its lifetime", async () => {
  const dependency = createServiceKey("dependency");
  const hidden = createServiceKey("hidden");
  const own = createServiceKey("own");
  const core = new EngineCore();
  let retainedContext;
  await core.mount({ id: "provider", requires: [], provides: [dependency, hidden], activate(context) {
    context.provide(dependency, 42);
    context.provide(hidden, 99);
  } });
  await core.mount({
    id: "consumer",
    requires: [dependency],
    provides: [own],
    activate(context) {
      retainedContext = context;
      assert.equal(context.get(dependency), 42);
      assert.throws(() => context.get(own), /not registered by plugin 'consumer'/);
      context.provide(own, undefined);
      assert.equal(context.get(own), undefined);
    },
    deactivate() {
      assert.equal(retainedContext.get(dependency), 42);
      assert.equal(retainedContext.get(own), undefined);
    },
  });
  assert.equal(core.get(own), undefined);
  assert.equal(retainedContext.get(dependency), 42);
  assert.equal(retainedContext.get(own), undefined);
  assert.throws(() => retainedContext.get(hidden), /cannot get undeclared/);
  assert.throws(() => retainedContext.provide(hidden, 1), /cannot provide undeclared/);
  assert.throws(() => retainedContext.provide(own, 1), /already registered/);
  await core.unmount("consumer");
  assert.throws(() => retainedContext.get(dependency), /no longer active/);
  await core.unmount("provider");
});

test("declaring provides alone does not allow reading another provider during activation", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  await assert.rejects(core.mount({
    id: "replacement",
    requires: [],
    provides: [service],
    activate(context) {
      assert.throws(() => context.get(service), /not registered by plugin 'replacement'/);
      context.provide(service, 99);
    },
  }), /already registered/);
  assert.equal(core.get(service), 42);
  await core.unmount("provider");
});

test("incomplete provides declarations roll back capabilities and release dependencies", async () => {
  const dependency = createServiceKey("dependency");
  const partial = createServiceKey("partial");
  const missing = createServiceKey("missing");
  const core = new EngineCore();
  let cleaned = false;
  let retainedContext;
  await core.mount({ id: "provider", requires: [], provides: [dependency], activate(context) { context.provide(dependency, 42); } });
  await assert.rejects(core.mount({
    id: "incomplete",
    requires: [dependency],
    provides: [partial, missing],
    activate(context) { retainedContext = context; context.provide(partial, "temporary"); },
    deactivate() { cleaned = true; assert.equal(retainedContext.get(partial), "temporary"); },
  }), /Plugin 'incomplete' did not provide declared services: 'missing'/);
  assert.equal(cleaned, true);
  assert.equal(core.isMounted("incomplete"), false);
  assert.throws(() => core.get(partial), /not registered/);
  assert.throws(() => core.get(missing), /not registered/);
  assert.throws(() => retainedContext.provide(missing, 1), /no longer active/);
  await core.unmount("provider");
});

test("unmount protection lists every dependent even when the capability has never been queried", async () => {
  const first = createServiceKey("first");
  const second = createServiceKey("second");
  const core = new EngineCore();
  let stopped = false;
  await core.mount({
    id: "provider",
    requires: [],
    provides: [first, second],
    activate(context) { context.provide(first, 1); context.provide(second, 2); },
    deactivate() { stopped = true; },
  });
  await core.mount({ id: "consumer-a", requires: [first, second], provides: [], activate() {} });
  await core.mount({ id: "consumer-b", requires: [second], provides: [], activate() {} });
  await assert.rejects(core.unmount("provider"), /Plugin 'provider' cannot be unmounted; required by plugins: 'consumer-a', 'consumer-b'/);
  assert.equal(stopped, false);
  assert.equal(core.isMounted("provider"), true);
  assert.equal(core.get(first), 1);
  await core.unmount("consumer-a");
  await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer-b'/);
  await core.unmount("consumer-b");
  await core.unmount("provider");
  assert.equal(stopped, true);
});

test("mutating declaration arrays cannot change access permissions or release dependencies", async () => {
  const dependency = createServiceKey("dependency");
  const hidden = createServiceKey("hidden");
  const own = createServiceKey("own");
  const requires = [dependency];
  const provides = [own];
  const core = new EngineCore();
  let retainedContext;
  await core.mount({ id: "provider", requires: [], provides: [dependency, hidden], activate(context) {
    context.provide(dependency, 42);
    context.provide(hidden, 99);
  } });
  await core.mount({ id: "consumer", requires, provides, activate(context) {
    retainedContext = context;
    context.provide(own, "own");
    provides.push(hidden);
  } });
  requires.splice(0, 1, hidden);
  provides.length = 0;
  assert.equal(retainedContext.get(dependency), 42);
  assert.equal(retainedContext.get(own), "own");
  assert.throws(() => retainedContext.get(hidden), /cannot get undeclared/);
  assert.throws(() => retainedContext.provide(hidden, 1), /cannot provide undeclared/);
  await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  await core.unmount("consumer");
  await core.unmount("provider");
});

test("capability key mutation cannot change a pending registration or its dependency identity", async () => {
  const mutable = { id: "service", token: Symbol("service") };
  const original = { ...mutable };
  const core = new EngineCore();
  await core.mount({
    id: "provider",
    requires: [],
    provides: [mutable],
    activate(context) {
      context.provide(mutable, 42);
      mutable.id = "changed";
      mutable.token = Symbol("changed");
    },
  });
  assert.equal(core.get(original), 42);
  assert.throws(() => core.get(mutable), /not registered/);
  await core.mount({ id: "consumer", requires: [original], provides: [], activate() {} });
  await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  await core.unmount("consumer");
  await core.unmount("provider");
});

test("providers cannot be unloaded while a dependent activation is pending", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const activation = deferred();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  const mounting = core.mount({ id: "consumer", requires: [service], provides: [], activate() { return activation.promise; } });
  try {
    assert.equal(core.isMounted("consumer"), false);
    await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  } finally {
    activation.resolve();
    await mounting;
  }
  await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  await core.unmount("consumer");
  await core.unmount("provider");
});

test("failed activation protects dependencies until cleanup finishes and then releases them", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const cleaning = deferred();
  const cleanup = deferred();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  const mounting = core.mount({
    id: "consumer",
    requires: [service],
    provides: [],
    activate() { throw new Error("activation failed"); },
    deactivate() { cleaning.resolve(); return cleanup.promise; },
  });
  const failure = assert.rejects(mounting, /activation failed/);
  await cleaning.promise;
  try {
    await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  } finally {
    cleanup.resolve();
    await failure;
  }
  await core.unmount("provider");
});

test("providers stay protected until a dependent deactivation finishes", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const deactivation = deferred();
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  await core.mount({ id: "consumer", requires: [service], provides: [], activate() {}, deactivate() { return deactivation.promise; } });
  const unmounting = core.unmount("consumer");
  try {
    await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  } finally {
    deactivation.resolve();
    await unmounting;
  }
  await core.unmount("provider");
});

test("a provider being deactivated cannot satisfy a new plugin dependency", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const deactivation = deferred();
  let activated = false;
  let cleaned = false;
  await core.mount({ id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); }, deactivate() { return deactivation.promise; } });
  const unmounting = core.unmount("provider");
  try {
    await assert.rejects(core.mount({
      id: "consumer",
      requires: [service],
      provides: [],
      activate() { activated = true; },
      deactivate() { cleaned = true; },
    }), /Plugin 'consumer' requires service 'service' from plugin 'provider', which is changing state/);
    assert.equal(activated, false);
    assert.equal(cleaned, false);
  } finally {
    deactivation.resolve();
    await unmounting;
  }
  assert.equal(core.isMounted("consumer"), false);
});

test("mountAll sorts a reversed dependency chain and waits for provider activation to finish", async () => {
  const document = createServiceKey("document");
  const editor = createServiceKey("editor");
  const workflow = createServiceKey("workflow");
  const activation = deferred();
  const events = [];
  const core = new EngineCore();
  const mounting = core.mountAll([
    { id: "workflow", requires: [editor], provides: [workflow], activate(context) {
      events.push("workflow");
      context.provide(workflow, context.get(editor) + " → workflow");
    } },
    { id: "editor", requires: [document], provides: [editor], activate(context) {
      events.push("editor");
      context.provide(editor, context.get(document) + " → editor");
    } },
    { id: "document", requires: [], provides: [document], async activate(context) {
      events.push("document:start");
      context.provide(document, "document");
      await activation.promise;
      events.push("document:ready");
    } },
  ]);
  try {
    assert.deepEqual(events, ["document:start"]);
    assert.throws(() => core.get(document), /not registered/);
    assert.equal(core.isMounted("editor"), false);
  } finally {
    activation.resolve();
    await mounting;
  }
  assert.deepEqual(events, ["document:start", "document:ready", "editor", "workflow"]);
  assert.equal(core.get(workflow), "document → editor → workflow");
  await assert.rejects(core.unmount("document"), /required by plugins: 'editor'/);
  await core.unmount("workflow");
  await core.unmount("editor");
  await core.unmount("document");
});

test("mountAll uses the earliest eligible input and keeps independent plugins deterministic", async () => {
  const dependency = createServiceKey("dependency");
  const events = [];
  const core = new EngineCore();
  await core.mountAll([
    { id: "first", requires: [dependency], provides: [], activate() { events.push("first"); } },
    { id: "provider", requires: [], provides: [dependency], activate(context) { events.push("provider"); context.provide(dependency, 42); } },
    { id: "independent-a", requires: [], provides: [], activate() { events.push("independent-a"); } },
    { id: "independent-b", requires: [], provides: [], activate() { events.push("independent-b"); } },
  ]);
  assert.deepEqual(events, ["provider", "first", "independent-a", "independent-b"]);
});

test("mountAll resolves a shared dependency graph with multiple capabilities from one provider", async () => {
  const config = createServiceKey("config");
  const text = createServiceKey("text");
  const format = createServiceKey("format");
  const left = createServiceKey("left");
  const right = createServiceKey("right");
  const events = [];
  const core = new EngineCore();
  await core.mount({ id: "config", requires: [], provides: [config], activate(context) { context.provide(config, "existing"); } });
  await core.mountAll([
    { id: "workflow", requires: [left, right, config], provides: [], activate(context) {
      events.push("workflow");
      assert.equal(context.get(left), "TEXT");
      assert.equal(context.get(right), "text");
      assert.equal(context.get(config), "existing");
    } },
    { id: "right", requires: [text], provides: [right], activate(context) { events.push("right"); context.provide(right, context.get(text)); } },
    { id: "left", requires: [text, format], provides: [left], activate(context) { events.push("left"); context.provide(left, context.get(format)(context.get(text))); } },
    { id: "provider", requires: [], provides: [text, format], activate(context) {
      events.push("provider");
      context.provide(text, "text");
      context.provide(format, (value) => value.toUpperCase());
    } },
  ]);
  assert.deepEqual(events, ["provider", "right", "left", "workflow"]);
});

test("batch preflight rejects missing capabilities, invalid declarations and duplicate ids without activation", async () => {
  const missing = createServiceKey("missing");
  const cases = [
    { plugin: { id: "missing", requires: [missing], provides: [] }, message: /Plugin 'missing' requires service 'missing', which has no provider/ },
    { plugin: { id: "invalid", provides: [] }, message: /must declare 'requires'/ },
    { plugin: { id: "invalid", requires: [] }, message: /must declare 'provides'/ },
    { plugin: { id: "duplicate-key", requires: [], provides: [missing, missing] }, message: /more than once in 'provides'/ },
    { plugin: { id: "ready", requires: [], provides: [] }, message: /Plugin 'ready' occurs more than once in the batch/ },
    { plugin: { id: " ", requires: [], provides: [] }, message: /Plugin id cannot be empty/ },
  ];
  for (const { plugin, message } of cases) {
    const core = new EngineCore();
    const calls = [];
    const callbacks = { activate() { calls.push("activate"); }, deactivate() { calls.push("deactivate"); } };
    await assert.rejects(core.mountAll([
      { id: "ready", requires: [], provides: [], ...callbacks },
      { ...plugin, ...callbacks },
    ]), message);
    assert.deepEqual(calls, []);
    assert.equal(core.isMounted("ready"), false);
    // 预检失败也须释放批量装配锁。
    await core.mountAll([{ id: "retry", requires: [], provides: [], activate() {} }]);
    await core.unmount("retry");
  }
});

test("batch preflight rejects multiple providers and conflicts with existing plugins", async () => {
  const service = createServiceKey("shared");
  const core = new EngineCore();
  const calls = [];
  const first = { id: "first", requires: [], provides: [service], activate() { calls.push("first"); } };
  const second = { id: "second", requires: [], provides: [service], activate() { calls.push("second"); } };
  await assert.rejects(core.mountAll([first, second]), /Service 'shared' has multiple providers: plugins 'first', 'second'/);
  assert.deepEqual(calls, []);
  await core.mount({ id: "existing", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  const ready = { id: "ready", requires: [], provides: [], activate() { calls.push("ready"); } };
  await assert.rejects(core.mountAll([ready, first]), /Service 'shared' declared by plugin 'first' is already provided by mounted plugin 'existing'/);
  await assert.rejects(core.mountAll([ready, { id: "existing", requires: [], provides: [], activate() { calls.push("duplicate"); } }]), /Plugin 'existing' is already mounted/);
  assert.deepEqual(calls, []);
  assert.equal(core.get(service), 42);
  await core.unmount("existing");
});

test("batch dependency matching uses key identity rather than the display name", async () => {
  const registered = createServiceKey("same-name");
  const required = createServiceKey("same-name");
  const core = new EngineCore();
  const provider = { id: "provider", requires: [], provides: [registered], activate() { assert.fail("Invalid batches must not activate."); } };
  const consumer = { id: "consumer", requires: [required], provides: [], activate() { assert.fail("Invalid batches must not activate."); } };
  await assert.rejects(core.mountAll([provider, consumer]), /Plugin 'consumer' requires service 'same-name', which has no provider/);
});

test("cycles report the actual capability chain and exclude blocked downstream plugins", async () => {
  const a = createServiceKey("a");
  const b = createServiceKey("b");
  const c = createServiceKey("c");
  const core = new EngineCore();
  const calls = [];
  const callbacks = { activate() { calls.push("activate"); }, deactivate() { calls.push("deactivate"); } };
  await assert.rejects(core.mountAll([
    { id: "downstream", requires: [a], provides: [], ...callbacks },
    { id: "independent", requires: [], provides: [], ...callbacks },
    { id: "C", requires: [a], provides: [c], ...callbacks },
    { id: "A", requires: [b], provides: [a], ...callbacks },
    { id: "B", requires: [c], provides: [b], ...callbacks },
  ]), (error) => {
    assert.equal(error.message, "Plugin dependency cycle: 'A' --[b]--> 'B' --[c]--> 'C' --[a]--> 'A'.");
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(core.isMounted("independent"), false);
  assert.throws(() => core.get(a), /not registered/);
});

test("self-dependencies are rejected as cycles before activation", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  await assert.rejects(core.mountAll([{
    id: "self",
    requires: [service],
    provides: [service],
    activate() { assert.fail("Self-dependencies must not activate."); },
  }]), (error) => {
    assert.equal(error.message, "Plugin dependency cycle: 'self' --[service]--> 'self'.");
    return true;
  });
});

test("batch activation failure rolls back new plugins in reverse order and preserves existing plugins", async () => {
  const existing = createServiceKey("existing");
  const providerKey = createServiceKey("provider");
  const middleKey = createServiceKey("middle");
  const failedKey = createServiceKey("failed");
  const error = new Error("activation failed");
  const core = new EngineCore();
  const events = [];
  const contexts = [];
  await core.mount({ id: "existing", requires: [], provides: [existing], activate(context) { context.provide(existing, 42); }, deactivate() { assert.fail("Existing plugins must remain mounted."); } });
  await assert.rejects(core.mountAll([
    { id: "failed", requires: [middleKey], provides: [failedKey], async activate(context) {
      contexts.push(context);
      events.push("failed:activate");
      context.provide(failedKey, 99);
      await Promise.resolve();
      throw error;
    }, deactivate() { events.push("failed:deactivate"); } },
    { id: "middle", requires: [providerKey], provides: [middleKey], activate(context) {
      contexts.push(context);
      events.push("middle:activate");
      context.provide(middleKey, context.get(providerKey));
    }, deactivate() { events.push("middle:deactivate"); } },
    { id: "provider", requires: [existing], provides: [providerKey], activate(context) {
      contexts.push(context);
      events.push("provider:activate");
      context.provide(providerKey, context.get(existing));
    }, deactivate() { events.push("provider:deactivate"); } },
    { id: "later", requires: [failedKey], provides: [], activate() { assert.fail("Plugins after a failure must not activate."); } },
  ]), (actual) => { assert.equal(actual, error); return true; });
  assert.deepEqual(events, ["provider:activate", "middle:activate", "failed:activate", "failed:deactivate", "middle:deactivate", "provider:deactivate"]);
  for (const id of ["provider", "middle", "failed", "later"]) assert.equal(core.isMounted(id), false);
  for (const key of [providerKey, middleKey, failedKey]) assert.throws(() => core.get(key), /not registered/);
  for (const context of contexts) assert.throws(() => context.get(existing), /no longer active/);
  assert.equal(core.isMounted("existing"), true);
  assert.equal(core.get(existing), 42);
  await core.mountAll([{ id: "provider", requires: [existing], provides: [], activate() {} }]);
  await core.unmount("provider");
});

test("incomplete capability registration triggers batch rollback before a consumer activates", async () => {
  const first = createServiceKey("first");
  const missing = createServiceKey("missing");
  const core = new EngineCore();
  const stopped = [];
  await assert.rejects(core.mountAll([
    { id: "first", requires: [], provides: [first], activate(context) { context.provide(first, 42); }, deactivate() { stopped.push("first"); } },
    { id: "incomplete", requires: [first], provides: [missing], activate() {}, deactivate() { stopped.push("incomplete"); } },
    { id: "consumer", requires: [missing], provides: [], activate() { assert.fail("Incomplete providers must not activate consumers."); } },
  ]), /Plugin 'incomplete' did not provide declared services: 'missing'/);
  assert.deepEqual(stopped, ["incomplete", "first"]);
  assert.equal(core.isMounted("first"), false);
  assert.throws(() => core.get(first), /not registered/);
});

test("batch rollback continues after cleanup failures and preserves all original errors", async () => {
  const first = createServiceKey("first");
  const second = createServiceKey("second");
  const activationError = new Error("activation failed");
  const cleanupError = new Error("failed plugin cleanup failed");
  const firstStopError = new Error("first cleanup failed");
  const secondStopError = new Error("second cleanup failed");
  const stopped = [];
  const core = new EngineCore();
  await assert.rejects(core.mountAll([
    { id: "failed", requires: [second], provides: [], activate() { throw activationError; }, deactivate() { stopped.push("failed"); throw cleanupError; } },
    { id: "second", requires: [first], provides: [second], activate(context) { context.provide(second, 2); }, deactivate() { stopped.push("second"); throw secondStopError; } },
    { id: "first", requires: [], provides: [first], activate(context) { context.provide(first, 1); }, deactivate() { stopped.push("first"); throw firstStopError; } },
  ]), (error) => {
    assert.ok(error instanceof PluginBatchActivationError);
    assert.equal(error.pluginId, "failed");
    assert.ok(error.activationError instanceof PluginActivationError);
    assert.equal(error.activationError.activationError, activationError);
    assert.equal(error.activationError.cleanupError, cleanupError);
    assert.deepEqual(Array.from(error.rollbackErrors, ({ pluginId }) => pluginId), ["second", "first"]);
    assert.equal(error.rollbackErrors[0].error, secondStopError);
    assert.equal(error.rollbackErrors[1].error, firstStopError);
    return true;
  });
  assert.deepEqual(stopped, ["failed", "second", "first"]);
  for (const id of ["first", "second", "failed"]) assert.equal(core.isMounted(id), false);
  for (const key of [first, second]) assert.throws(() => core.get(key), /not registered/);
  await core.mountAll([{ id: "retry", requires: [], provides: [], activate() {} }]);
  await core.unmount("retry");
});

test("batch mounting excludes other lifecycle operations while keeping existing capabilities readable", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const activation = deferred();
  await core.mount({ id: "existing", requires: [], provides: [service], activate(context) { context.provide(service, 42); } });
  const mounting = core.mountAll([{ id: "slow", requires: [service], provides: [], activate() { return activation.promise; } }]);
  try {
    await assert.rejects(core.mount({ id: "other", requires: [], provides: [], activate() { assert.fail("Concurrent operations must not activate."); } }), /batch mounting is in progress/);
    await assert.rejects(core.unmount("existing"), /batch mounting is in progress/);
    await assert.rejects(core.mountAll([]), /batch mounting is in progress/);
    assert.equal(core.get(service), 42);
  } finally {
    activation.resolve();
    await mounting;
  }
  await core.unmount("slow");
  await core.unmount("existing");
});

test("batch exclusion lasts through failed activation cleanup and asynchronous rollback", async () => {
  const service = createServiceKey("service");
  const core = new EngineCore();
  const cleanupStarted = deferred();
  const cleanup = deferred();
  const rollbackStarted = deferred();
  const rollback = deferred();
  const mounting = core.mountAll([
    { id: "provider", requires: [], provides: [service], activate(context) { context.provide(service, 42); }, deactivate() { rollbackStarted.resolve(); return rollback.promise; } },
    { id: "failed", requires: [service], provides: [], activate() { throw new Error("activation failed"); }, deactivate() { cleanupStarted.resolve(); return cleanup.promise; } },
  ]);
  const failure = assert.rejects(mounting, /activation failed/);
  await cleanupStarted.promise;
  try {
    await assert.rejects(core.unmount("provider"), /batch mounting is in progress/);
    await assert.rejects(core.mountAll([]), /batch mounting is in progress/);
  } finally {
    cleanup.resolve();
  }
  await rollbackStarted.promise;
  try {
    await assert.rejects(core.mount({ id: "consumer", requires: [service], provides: [], activate() { assert.fail("Rollback must remain exclusive."); } }), /batch mounting is in progress/);
    await assert.rejects(core.unmount("provider"), /batch mounting is in progress/);
  } finally {
    rollback.resolve();
    await failure;
  }
  assert.equal(core.isMounted("provider"), false);
  await core.mountAll([]);
});

test("batch mounting cannot start during an existing mount or unmount operation", async () => {
  for (const operation of ["mount", "unmount"]) {
    const core = new EngineCore();
    const gate = deferred();
    const plugin = { id: "busy", requires: [], provides: [], activate() { return operation === "mount" ? gate.promise : undefined; }, deactivate() { return gate.promise; } };
    if (operation === "unmount") await core.mount(plugin);
    const changing = operation === "mount" ? core.mount(plugin) : core.unmount("busy");
    try {
      await assert.rejects(core.mountAll([{ id: "new", requires: [], provides: [], activate() { assert.fail("Busy runtimes must reject batches."); } }]), /Cannot mount plugin batch while plugins are changing state: 'busy'/);
    } finally {
      gate.resolve();
      await changing;
    }
    await core.mountAll([{ id: "new", requires: [], provides: [], activate() {} }]);
    await core.unmount("new");
    if (operation === "mount") await core.unmount("busy");
  }
});

test("batch plans snapshot all ids and declarations before earlier plugins can mutate them", async () => {
  const dependency = createServiceKey("dependency");
  const own = createServiceKey("own");
  const hidden = createServiceKey("hidden");
  const requires = [dependency];
  const provides = [own];
  const core = new EngineCore();
  const consumer = { id: "consumer", requires, provides, activate(context) {
    assert.equal(context.get(dependency), 42);
    context.provide(own, "original");
    assert.throws(() => context.get(hidden), /cannot get undeclared/);
    assert.throws(() => context.provide(hidden, 99), /cannot provide undeclared/);
  } };
  const plugins = [consumer, { id: "provider", requires: [], provides: [dependency], activate(context) {
    context.provide(dependency, 42);
    consumer.id = "changed";
    requires.splice(0, 1, hidden);
    provides.splice(0, 1, hidden);
    plugins.length = 0;
  } }];
  await core.mountAll(plugins);
  assert.equal(core.isMounted("consumer"), true);
  assert.equal(core.isMounted("changed"), false);
  assert.equal(core.get(own), "original");
  await assert.rejects(core.unmount("provider"), /required by plugins: 'consumer'/);
  await core.unmount("consumer");
  await core.unmount("provider");
});

test("empty batches are harmless and release the lifecycle lock", async () => {
  const core = new EngineCore();
  assert.equal(await core.mountAll([]), undefined);
  await core.mount({ id: "manual", requires: [], provides: [], activate() {} });
  await core.unmount("manual");
});
