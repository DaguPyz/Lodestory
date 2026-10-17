import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "src");
const sdkRoot = resolve(repositoryRoot, "packages/sdk/src");

function createFixture() {
  const modules = new Map();
  const values = new Map();
  const reports = [];
  const localStorageControl = {readError: null, writeError: null};
  const localStorage = {
    getItem(key) {
      if (localStorageControl.readError) throw localStorageControl.readError;
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (localStorageControl.writeError) throw localStorageControl.writeError;
      values.set(key, String(value));
    },
  };
  const window = {localStorage};
  const fixtureConsole = {
    error(...args) { reports.push(args); },
    warn(...args) { reports.push(args); },
    log(...args) { reports.push(args); },
  };

  function resolveImport(fromPath, specifier) {
    const root = specifier.startsWith("@lodestory/sdk") ? sdkRoot : dirname(fromPath);
    if (!specifier.startsWith(".") && !specifier.startsWith("@lodestory/sdk")) {
      throw new Error(`Unexpected external import '${specifier}' from ${relative(repositoryRoot, fromPath)}`);
    }
    let base;
    if (specifier.startsWith("@lodestory/sdk")) {
      const subpath = specifier === "@lodestory/sdk" ? "index" : specifier.slice("@lodestory/sdk/".length);
      base = resolve(sdkRoot, subpath);
    } else {
      base = resolve(root, specifier);
    }
    const withoutJs = base.endsWith(".js") ? base.slice(0, -3) : base;
    const candidates = [base, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${withoutJs}.json`, resolve(withoutJs, "index.ts"), resolve(withoutJs, "index.tsx")];
    const path = candidates.find(candidate => {
      try { readFileSync(candidate, "utf8"); return true; }
      catch { return false; }
    });
    if (!path) throw new Error(`Cannot resolve '${specifier}' from ${fromPath}`);
    return path;
  }

  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    if (path.endsWith(".json")) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      const jsonModule = {__esModule: true, default: data, ...data};
      modules.set(path, jsonModule);
      return jsonModule;
    }
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      console: fixtureConsole,
      window,
      localStorage,
      Object,
      Array,
      JSON,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Symbol,
      Error,
      TypeError,
      Number,
      String,
      Boolean,
      Reflect,
      RegExp,
      Date,
      Math,
      queueMicrotask,
      require(specifier) { return load(resolveImport(path, specifier)); },
    }, {filename: path});
    return exports;
  }

  return {
    values,
    reports,
    localStorageControl,
    loadModule(relativePath) { return load(resolve(sourceRoot, relativePath)); },
    requireSdk(specifier) { return load(resolveImport(resolve(repositoryRoot, "fixture.mjs"), specifier)); },
  };
}

const numberItem = (id = "example.number", defaultValue = 1) => ({
  id,
  defaultValue,
  effect: "live",
  validate: value => typeof value === "number" && Number.isFinite(value),
});
const objectItem = (id = "example.object", defaultValue = {nested: {value: 1}}) => ({
  id,
  defaultValue,
  effect: "live",
  validate: value => value !== null && typeof value === "object" && !Array.isArray(value),
});
const tick = () => new Promise(resolvePromise => setImmediate(resolvePromise));

function createStore(f, options = {}) {
  return f.loadModule("plugins/config/configStore.ts").createConfigStore({
    baseValues: {},
    userValues: {},
    persist() {},
    ...options,
  });
}

test("configuration resolves user, application and declared defaults with immutable stable snapshots", async () => {
  const persisted = [];
  const store = createStore(createFixture(), {
    baseValues: {"example.user": 3, "example.base": 2},
    userValues: {"example.user": 4},
    persist: values => persisted.push(values),
  });
  const user = numberItem("example.user", 1);
  const base = numberItem("example.base", 1);
  const fallback = numberItem("example.default", 1);
  store.service.register(user);
  store.service.register(base);
  store.service.register(fallback);

  assert.equal(store.service.getSnapshot(user), 4);
  assert.equal(store.service.getSnapshot(base), 2);
  assert.equal(store.service.getSnapshot(fallback), 1);
  assert.equal(store.service.getSnapshot(user), store.service.getSnapshot(user));
  await store.dispose();
  assert.deepEqual(persisted, []);
});

test("object values are deeply cloned, frozen, stable until changed, and replaced as a whole", async () => {
  const store = createStore(createFixture(), {persist() {}});
  const item = objectItem("example.object", {nested: {value: 1}, keep: true});
  store.service.register(item);
  const initial = store.service.getSnapshot(item);
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.nested));
  assert.throws(() => { initial.nested.value = 10; }, TypeError);
  assert.equal(store.service.getSnapshot(item), initial);

  const input = {nested: {value: 2}};
  await store.service.set(item, input);
  input.nested.value = 99;
  const next = store.service.getSnapshot(item);
  assert.equal(JSON.stringify(next), JSON.stringify({nested: {value: 2}}));
  assert.notEqual(next, initial);
  assert.equal(store.service.getSnapshot(item), next);
  await store.dispose();
});

test("registration validates declarations and base values; bad saved values fall back without rewriting", async () => {
  const reports = [];
  const writes = [];
  const store = createStore(createFixture(), {
    baseValues: {"example.bad-base": "bad"},
    userValues: {"example.bad-user": "bad"},
    persist: values => writes.push(values),
    report: (...args) => reports.push(args),
  });
  const badDefault = {...numberItem("example.same"), defaultValue: "bad"};
  assert.throws(() => store.service.register(badDefault), /default/i);
  const item = numberItem("example.bad-user", 7);
  store.service.register(item);
  assert.equal(store.service.getSnapshot(item), 7);
  assert.equal(reports.length, 1);
  assert.match(String(reports[0][0]), /example\.bad-user/);
  assert.deepEqual(writes, []);

  assert.throws(() => store.service.register(numberItem("example.bad-base", 1)), /base|invalid/i);
  store.service.register(numberItem("example.same", 1));
  await store.dispose();
});

test("invalid IDs, duplicate IDs, mismatched declarations and unregistered access are rejected", async () => {
  const store = createStore(createFixture(), {persist() {}});
  for (const id of ["", " "]) {
    assert.throws(() => store.service.register(numberItem(id)), /id/i);
  }
  const item = numberItem("example.unique");
  const remove = store.service.register(item);
  assert.throws(() => store.service.register(item), /already|duplicate/i);
  assert.throws(() => store.service.getSnapshot(numberItem(item.id)), /registered|declaration/i);
  await assert.rejects(store.service.set(numberItem(item.id), 3), /registered|declaration/i);
  await assert.rejects(store.service.reset(numberItem(item.id)), /registered|declaration/i);
  assert.throws(() => store.service.subscribe(numberItem(item.id), () => {}), /registered|declaration/i);
  remove();
  remove();
  const newRemove = store.service.register(item);
  remove();
  assert.equal(store.service.getSnapshot(item), item.defaultValue);
  newRemove();
  await store.dispose();
});

test("JSON-only values reject non-finite, undefined, callable, exotic and cyclic data", async () => {
  const store = createStore(createFixture(), {persist() {}});
  const item = objectItem("example.json");
  store.service.register(item);
  const cyclic = {};
  cyclic.self = cyclic;
  const invalid = [
    NaN,
    Infinity,
    undefined,
    () => {},
    new Date(),
    new Map(),
    cyclic,
    {nested: undefined},
    {nested: Infinity},
  ];
  for (const value of invalid) await assert.rejects(store.service.set(item, value));
  assert.equal(JSON.stringify(store.service.getSnapshot(item)), JSON.stringify({nested: {value: 1}}));
  await store.dispose();
});

test("set and reset serialize globally, publish only after persistence, and continue after a failed write", async () => {
  const writes = [];
  const gates = [];
  const store = createStore(createFixture(), {
    baseValues: {"example.queued": 0},
    persist(values) {
      writes.push(values);
      const gate = gates.shift();
      return gate.promise;
    },
  });
  const item = numberItem("example.queued", -1);
  store.service.register(item);
  const gate1 = deferred();
  const gate2 = deferred();
  const gate3 = deferred();
  gates.push(gate1, gate2, gate3);
  const first = store.service.set(item, 1);
  const second = store.service.set(item, 2);
  const third = store.service.set(item, 3);
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(store.service.getSnapshot(item), 0);

  gate1.resolve();
  await first;
  await tick();
  assert.equal(writes.length, 2);
  assert.equal(store.service.getSnapshot(item), 1);

  gate2.reject(new Error("disk full"));
  await assert.rejects(second, /disk full/);
  await tick();
  assert.equal(writes.length, 3);
  assert.equal(store.service.getSnapshot(item), 1);

  gate3.resolve();
  await third;
  assert.equal(store.service.getSnapshot(item), 3);
  assert.equal(writes[0][item.id], 1);
  assert.equal(writes[1][item.id], 2);
  assert.equal(writes[2][item.id], 3);
  await store.dispose();
});

test("no-op values do not notify; reset restores base/default and deletes only the target override", async () => {
  const writes = [];
  const store = createStore(createFixture(), {
    baseValues: {"example.reset": 5, "example.other": 8},
    userValues: {"example.reset": 6, "example.other": 9},
    persist: values => writes.push(values),
  });
  const item = numberItem("example.reset", 1);
  const other = numberItem("example.other", 2);
  store.service.register(item);
  store.service.register(other);
  let calls = 0;
  const unsubscribe = store.service.subscribe(item, () => calls++);
  await store.service.set(item, 6);
  assert.equal(calls, 0);
  await store.service.reset(item);
  assert.equal(store.service.getSnapshot(item), 5);
  assert.equal(calls, 1);
  assert.deepEqual(Object.entries(writes.at(-1)), [["example.other", 9]]);
  assert.equal(store.service.getSnapshot(other), 9);
  unsubscribe();
  await store.dispose();
});

test("throwing subscribers are isolated and other listeners still receive committed values", async () => {
  const reports = [];
  const store = createStore(createFixture(), {persist() {}, report: (...args) => reports.push(args)});
  const item = numberItem();
  store.service.register(item);
  let calls = 0;
  store.service.subscribe(item, () => { throw new Error("listener failed"); });
  store.service.subscribe(item, () => { calls++; });
  await store.service.set(item, 2);
  assert.equal(calls, 1);
  assert.equal(reports.length, 1);
  assert.equal(store.service.getSnapshot(item), 2);
  await store.dispose();
});

test("seal prevents later registration while existing entries remain usable", async () => {
  const store = createStore(createFixture(), {persist() {}});
  const item = numberItem();
  store.service.register(item);
  store.seal();
  assert.throws(() => store.service.register(numberItem("example.late")), /sealed|pluginsReady/i);
  assert.equal(store.service.getSnapshot(item), 1);
  await store.service.set(item, 3);
  assert.equal(store.service.getSnapshot(item), 3);
  await store.dispose();
});

test("a write revoked before reaching the persistence queue is rejected without writing", async () => {
  const gate = deferred();
  const writes = [];
  const store = createStore(createFixture(), {
    persist(values) {
      writes.push(values);
      return gate.promise;
    },
  });
  const blocker = numberItem("example.blocker", 0);
  const item = numberItem("example.queued-revocation", 1);
  store.service.register(blocker);
  const removeOld = store.service.register(item);
  const first = store.service.set(blocker, 2);
  const canceled = store.service.set(item, 5);
  removeOld();
  const removeNew = store.service.register(item);

  gate.resolve();
  await first;
  await assert.rejects(canceled, /unregistered|saving/i);
  assert.equal(writes.length, 1);
  assert.equal(store.service.getSnapshot(item), 1);
  removeNew();
  await store.dispose();
});

test("an already-started write is revalidated against the current same-ID declaration", async t => {
  await t.test("same type receives the saved value and notification", async () => {
    const gate = deferred();
    const store = createStore(createFixture(), {persist: () => gate.promise});
    const item = numberItem();
    const removeOld = store.service.register(item);
    const pending = store.service.set(item, 5);
    await tick();
    removeOld();
    store.service.register(item);
    let calls = 0;
    store.service.subscribe(item, () => calls++);
    gate.resolve();
    await pending;
    assert.equal(store.service.getSnapshot(item), 5);
    assert.equal(calls, 1);
    await store.dispose();
  });

  await t.test("a different type falls back and reports the incompatible saved value", async () => {
    const gate = deferred();
    const reports = [];
    const store = createStore(createFixture(), {persist: () => gate.promise, report: (...args) => reports.push(args)});
    const oldItem = numberItem("example.shared-id", 1);
    const removeOld = store.service.register(oldItem);
    const pending = store.service.set(oldItem, 5);
    await tick();
    removeOld();
    const newItem = {
      id: oldItem.id,
      defaultValue: "fallback",
      effect: "restart",
      validate: value => typeof value === "string",
    };
    store.service.register(newItem);
    let calls = 0;
    store.service.subscribe(newItem, () => calls++);
    gate.resolve();
    await pending;
    assert.equal(store.service.getSnapshot(newItem), "fallback");
    assert.equal(calls, 0);
    assert.equal(reports.length, 1);
    assert.match(String(reports[0][0]), /example\.shared-id/);
    await store.dispose();
  });
});

test("dispose rejects new requests and waits for writes already accepted", async () => {
  const gate = deferred();
  const store = createStore(createFixture(), {persist: () => gate.promise});
  const item = numberItem();
  store.service.register(item);
  const pending = store.service.set(item, 4);
  const disposing = store.dispose();
  await assert.rejects(store.service.set(item, 5), /disposed|disposing|closed|no longer active/i);
  let disposed = false;
  void disposing.then(() => { disposed = true; });
  await tick();
  assert.equal(disposed, false);
  gate.resolve();
  await pending;
  await disposing;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function activateConfigPlugin(f, plugin, configKey) {
  let service;
  const handlers = [];
  await plugin.activate({
    provide(key, value) { if (key === configKey) service = value; },
    on(key, listener) { handlers.push({key, listener}); return () => {}; },
  });
  return {service, handlers};
}

test("configuration plugin provides the SDK service, loads its base file and persists user overrides", async () => {
  const f = createFixture();
  const {createConfigPlugin} = f.loadModule("plugins/config/configPlugin.ts");
  const {configKey} = f.requireSdk("@lodestory/sdk/config");
  const plugin = createConfigPlugin();
  assert.equal(plugin.requires.length, 0);
  assert.ok(plugin.provides.includes(configKey));
  const {service: provided, handlers} = await activateConfigPlugin(f, plugin, configKey);

  const initialPage = {
    id: "ui.initialPage",
    defaultValue: null,
    effect: "restart",
    validate: value => value === null || typeof value === "string",
  };
  const remove = provided.register(initialPage);
  assert.equal(provided.getSnapshot(initialPage), "welcome");
  assert.equal(handlers.length, 1, "the plugin seals registrations at pluginsReady");
  handlers[0].listener();
  assert.throws(() => provided.register({...initialPage, id: "ui.late"}), /sealed|pluginsReady/i);
  await provided.set(initialPage, "settings");
  assert.deepEqual(JSON.parse(f.values.get("lodestory.config-overrides")), {"ui.initialPage": "settings"});
  await provided.reset(initialPage);
  assert.equal(provided.getSnapshot(initialPage), "welcome");
  const savedOverrides = f.values.get("lodestory.config-overrides");
  assert.ok(savedOverrides === undefined || !Object.hasOwn(JSON.parse(savedOverrides), initialPage.id));
  remove();
  await plugin.deactivate?.();
});

test("configuration plugin tolerates corrupt or unreadable startup storage and rejects failed writes", async () => {
  for (const scenario of ["corrupt", "read-error", "write-error"]) {
    const f = createFixture();
    if (scenario === "corrupt") f.values.set("lodestory.config-overrides", "{");
    if (scenario === "read-error") f.localStorageControl.readError = new Error("storage unavailable");
    if (scenario === "write-error") f.localStorageControl.writeError = new Error("quota exceeded");
    const {createConfigPlugin} = f.loadModule("plugins/config/configPlugin.ts");
    const {configKey} = f.requireSdk("@lodestory/sdk/config");
    const plugin = createConfigPlugin();
    const {service} = await activateConfigPlugin(f, plugin, configKey);
    const item = {
      id: "ui.initialPage",
      defaultValue: null,
      effect: "restart",
      validate: value => value === null || typeof value === "string",
    };
    service.register(item);
    assert.equal(service.getSnapshot(item), "welcome");
    if (scenario === "write-error") {
      await assert.rejects(service.set(item, "settings"), /quota exceeded/);
      assert.equal(service.getSnapshot(item), "welcome");
    } else {
      assert.ok(f.reports.length > 0, "startup storage problem should be reported");
    }
    await plugin.deactivate?.();
  }
});
