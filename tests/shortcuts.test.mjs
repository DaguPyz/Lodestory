import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "src");
const sdk = resolve(root, "packages/sdk/src");

function fixture() {
  const modules = new Map();
  const writes = [];
  const wrappers = new Map();
  const sections = new Map();
  const jsx = {Fragment: Symbol("Fragment"), jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props})};
  function pathOf(from, specifier) {
    let base = specifier.startsWith("@lodestory/sdk/") ? resolve(sdk, specifier.slice("@lodestory/sdk/".length))
      : specifier === "@lodestory/sdk" ? resolve(sdk, "index")
      : resolve(dirname(from), specifier);
    const noExtension = base.endsWith(".js") ? base.slice(0, -3) : base;
    const candidates = [base, `${noExtension}.ts`, `${noExtension}.tsx`, resolve(noExtension, "index.ts")];
    const found = candidates.find(path => { try { readFileSync(path, "utf8"); return true; } catch { return false; } });
    if (!found) throw new Error(`Cannot resolve '${specifier}' from ${relative(root, from)}`);
    return found;
  }
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const sourceText = readFileSync(path, "utf8");
    const output = ts.transpileModule(sourceText, {fileName: path, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    }}).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(output, {exports, console, require(specifier) {
      if (specifier === "react") return {useEffect() {}};
      if (specifier === "react/jsx-runtime") return jsx;
      if (specifier === "@lodestory/ui") return {Button() {}, SearchField() {}, TextField() {}};
      if (specifier.endsWith(".css")) return {};
      return load(pathOf(path, specifier));
    }}, {filename: path});
    return exports;
  }
  const context = {
    track: value => value,
    services: new Map(),
    get(key) {
      if (key === sdkConfig.configKey) return config.service;
      if (key === sdkUi.uiInteractionKey) return {hasActiveOverlay: () => false, wrap: children => children};
      if (key === sdkUi.uiKey) return {addWrapper(wrapper) {
        wrappers.set(wrapper.id, wrapper);
        return () => wrappers.delete(wrapper.id);
      }};
      if (key === sdkSettings.settingsKey) return {registerSection(section) {
        sections.set(section.id, section);
        return () => sections.delete(section.id);
      }};
      throw new Error(`Unexpected capability ${key?.id}`);
    },
    provide(key, value) { this.services.set(key, value); },
  };
  const sdkConfig = load(resolve(sdk, "config.ts"));
  const sdkUi = load(resolve(sdk, "ui.ts"));
  const sdkSettings = load(resolve(sdk, "settings.ts"));
  const {createConfigStore} = load(resolve(source, "plugins/config/configStore.ts"));
  config = createConfigStore({baseValues: {}, userValues: {}, persist(value) { writes.push(value); }});
  const shortcutsPlugin = load(resolve(source, "plugins/shortcuts/shortcutsPlugin.tsx"));
  return {load, writes, wrappers, sections, context, sdkConfig, sdkUi, shortcutsPlugin, config};
}

let config;
const event = (key, options = {}) => ({key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  isComposing: false, keyCode: 0, repeat: false, defaultPrevented: false, prevented: false,
  preventDefault() { this.prevented = true; }, getModifierState() { return false; }, ...options});
const context = (overrides = {}) => ({blocked: false, editable: false, target: null, ...overrides});

function createStore(isMac = false) {
  const {createShortcutsStore} = fixture().load(resolve(source, "plugins/shortcuts/shortcutsStore.ts"));
  const values = {};
  const store = createShortcutsStore({getOverrides: () => values, isMac: () => isMac, async persist(id, keys) {
    if (keys === "Mod+Shift+X") throw new Error("disk full");
    if (keys === undefined) delete values[id]; else values[id] = keys;
  }});
  return {store, values};
}

test("Mod is platform-aware; F-key chords and canonical formatting remain stable", async () => {
  const {store: mac} = createStore(true);
  const {store: other} = createStore(false);
  assert.equal(mac.service.getSnapshot().commands.length, 0);
  assert.equal(typeof mac.service.setBinding === "function", true);
  const macScope = mac.service.registerScope({id: "application", active: () => true});
  const otherScope = other.service.registerScope({id: "application", active: () => true});
  for (const store of [mac, other]) {
    store.service.registerCommand({id: "test.open", title: "打开", category: "测试", run() {}});
    store.service.registerBinding({id: "test.open-key", commandId: "test.open", scopeId: "application", keys: "Shift + Mod + f"});
  }
  assert.equal(mac.service.getShortcut("test.open"), "⌘ ⇧ F");
  assert.equal(other.service.getShortcut("test.open"), "Ctrl + Shift + F");
  await other.service.setBinding("test.open-key", "Mod+Ctrl+S");
  assert.equal(other.service.getShortcut("test.open"), "Ctrl + S", "equivalent Windows modifiers are shown once");
  assert.equal(mac.handleKeyDown(event("F2"), context()), false);
  mac.dispose(); other.dispose(); macScope(); otherScope();
});

test("ordinary text and local editing keys are rejected as global bindings", () => {
  const {normalizeShortcut} = fixture().load(resolve(source, "plugins/shortcuts/shortcutsStore.ts"));
  for (const chord of ["A", "Shift+A", "Shift+Space", "Shift+ArrowLeft", "Shift+Tab", "Tab", "Escape", "Mod++S", "Mod+ +S"]) {
    assert.throws(() => normalizeShortcut(chord), undefined, `${chord} cannot hijack plain typing or local editing`);
  }
  assert.equal(normalizeShortcut("Shift+F2"), "Shift+F2");
  assert.equal(normalizeShortcut("Mod+Space"), "Mod+Space");
});

test("recording maps real keyboard events to platform-aware chords and rejects unsupported input", () => {
  const {shortcutFromKeyEvent, formatShortcut} = fixture().load(resolve(source, "plugins/shortcuts/shortcutsStore.ts"));
  assert.equal(shortcutFromKeyEvent(event("n", {metaKey: true, shiftKey: true}), true), "Mod+Shift+N");
  assert.equal(shortcutFromKeyEvent(event("n", {ctrlKey: true, shiftKey: true}), false), "Mod+Shift+N");
  assert.equal(shortcutFromKeyEvent(event("n", {ctrlKey: true}), true), "Ctrl+N");
  assert.equal(shortcutFromKeyEvent(event(" ", {metaKey: true}), true), "Mod+Space");
  assert.equal(shortcutFromKeyEvent(event("F2"), false), "F2");
  assert.equal(shortcutFromKeyEvent(event("Shift", {shiftKey: true}), true), null);
  assert.equal(shortcutFromKeyEvent(event("a", {isComposing: true}), true), null);
  assert.equal(shortcutFromKeyEvent(event("a", {getModifierState: key => key === "AltGraph"}), false), null);
  assert.throws(() => shortcutFromKeyEvent(event("a"), true), /shortcut must use/i);
  assert.throws(() => shortcutFromKeyEvent(event("a", {metaKey: true}), false), /system key/i);
  assert.equal(formatShortcut("Mod+Shift+N", true), "⌘ ⇧ N");
  assert.equal(formatShortcut("Mod+Shift+N", false), "Ctrl + Shift + N");
});

test("a child scope wins; inactive ancestors and unknown scopes cannot dispatch", async () => {
  const {store} = createStore();
  let parentActive = true;
  let globalCalls = 0, childCalls = 0;
  store.service.registerScope({id: "application", active: () => true});
  store.service.registerCommand({id: "test.global", title: "全局", category: "测试", run() { globalCalls++; }});
  store.service.registerCommand({id: "test.child", title: "当前文稿", category: "测试", run() { childCalls++; }});
  store.service.registerBinding({id: "test.global-key", commandId: "test.global", scopeId: "application", keys: "Mod+S"});
  store.service.registerBinding({id: "test.child-key", commandId: "test.child", scopeId: "document", keys: "Mod+S"});
  store.handleKeyDown(event("s", {ctrlKey: true}), context());
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(globalCalls, 1, "an active parent-scope binding can run while the child scope is absent");
  store.service.registerScope({id: "workbench", parentId: "application", active: () => parentActive});
  store.service.registerScope({id: "document", parentId: "workbench", active: () => true});
  const target = {};
  store.handleKeyDown(event("s", {ctrlKey: true}), context({target}));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(globalCalls, 1);
  assert.equal(childCalls, 1);
  parentActive = false;
  store.handleKeyDown(event("s", {ctrlKey: true}), context({target}));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(childCalls, 1, "a registered child cannot outlive an inactive parent scope");
  store.dispose();
});

test("same-scope conflicts consume without choosing by registration order", async () => {
  const {store} = createStore();
  let first = 0, second = 0;
  store.service.registerScope({id: "application", active: () => true});
  store.service.registerCommand({id: "test.first", title: "第一项", category: "测试", run() { first++; }});
  store.service.registerCommand({id: "test.second", title: "第二项", category: "测试", run() { second++; }});
  store.service.registerBinding({id: "test.first-key", commandId: "test.first", scopeId: "application", keys: "Mod+S"});
  store.service.registerBinding({id: "test.second-key", commandId: "test.second", scopeId: "application", keys: "Ctrl+S"});
  const shortcut = event("s", {ctrlKey: true});
  assert.equal(store.handleKeyDown(shortcut, context()), true);
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(shortcut.prevented, true);
  assert.equal(first + second, 0);
  assert.equal(store.service.getSnapshot().conflicts.length, 1);
  assert.equal(store.service.getShortcut("test.first"), undefined, "a conflicted binding is never advertised as active");
  store.dispose();
});

test("IME, repeat, already-handled, editable, and blocked events are ignored", () => {
  const {store} = createStore();
  let calls = 0;
  store.service.registerScope({id: "application", active: () => true});
  store.service.registerCommand({id: "test.save", title: "保存", category: "测试", run() { calls++; }});
  store.service.registerBinding({id: "test.save-key", commandId: "test.save", scopeId: "application", keys: "Mod+S", allowInInput: true});
  const key = () => event("s", {ctrlKey: true});
  for (const [candidate, state] of [[{...key(), isComposing: true}, {}], [{...key(), keyCode: 229}, {}],
    [{...key(), defaultPrevented: true}, {}], [key(), {blocked: true}]]) {
    assert.equal(store.handleKeyDown(candidate, context(state)), false);
  }
  store.service.registerCommand({id: "test.edit", title: "编辑", category: "测试", run() {}});
  store.service.registerBinding({id: "test.edit-key", commandId: "test.edit", scopeId: "application", keys: "Mod+E"});
  assert.equal(store.handleKeyDown(event("e", {ctrlKey: true}), context({editable: true})), false,
    "commands do not take keys from editors unless their binding opts in");
  store.service.registerBinding({id: "test.save-other", commandId: "test.save", scopeId: "application", keys: "Mod+Shift+F"});
  const inputKey = event("f", {ctrlKey: true, shiftKey: true});
  assert.equal(store.handleKeyDown(inputKey, context({editable: true})), false);
  assert.equal(store.handleKeyDown(key(), context()), true);
  assert.equal(calls, 1);
  const repeat = event("s", {ctrlKey: true, repeat: true});
  assert.equal(store.handleKeyDown(repeat, context()), true);
  assert.equal(repeat.prevented, true, "a held shortcut suppresses browser defaults without invoking the command twice");
  assert.equal(calls, 1, "the repeated key never re-enters the pending command");
  store.dispose();
});

test("disabled commands and concurrent invocations do not run twice", async () => {
  const {store} = createStore();
  let enabled = false, calls = 0, finish;
  store.service.registerScope({id: "application", active: () => true});
  store.service.registerCommand({id: "test.wait", title: "等待", category: "测试", enabled: () => enabled,
    run() { calls++; return new Promise(resolvePromise => { finish = resolvePromise; }); }});
  store.service.registerBinding({id: "test.wait-key", commandId: "test.wait", scopeId: "application", keys: "Mod+S"});
  assert.equal(await store.service.execute("test.wait"), false);
  enabled = true;
  const first = store.service.execute("test.wait");
  const second = await store.service.execute("test.wait");
  assert.equal(second, false);
  assert.equal(calls, 1);
  finish();
  assert.equal(await first, true);
  assert.equal(store.service.getSnapshot().commands[0].running, false);

  let finishOld, finishNew;
  const removeOld = store.service.registerCommand({id: "test.replace", title: "旧命令", category: "测试",
    run() { return new Promise(resolvePromise => { finishOld = resolvePromise; }); }});
  const oldRun = store.service.execute("test.replace");
  removeOld();
  store.service.registerCommand({id: "test.replace", title: "新命令", category: "测试",
    run() { return new Promise(resolvePromise => { finishNew = resolvePromise; }); }});
  const newRun = store.service.execute("test.replace");
  finishOld();
  await oldRun;
  assert.equal(store.service.getSnapshot().commands.find(item => item.id === "test.replace").running, true,
    "a stale completion cannot clear a replacement command's pending state");
  finishNew();
  await newRun;
  assert.equal(store.service.getSnapshot().commands.find(item => item.id === "test.replace").running, false);
  store.dispose();
});

test("binding changes persist first, reject conflicts, and keep the old shortcut after a failed write", async () => {
  const {store, values} = createStore();
  store.service.registerScope({id: "application", active: () => true});
  for (const id of ["one", "two"]) store.service.registerCommand({id: `test.${id}`, title: id, category: "测试", run() {}});
  store.service.registerBinding({id: "test.one-key", commandId: "test.one", scopeId: "application", keys: "Mod+S"});
  store.service.registerBinding({id: "test.two-key", commandId: "test.two", scopeId: "application", keys: "Mod+N"});
  assert.equal(store.service.getSnapshot().bindings[1].defaultLabel, "Ctrl + N");
  assert.equal(store.service.getSnapshot().bindings[1].customized, false);
  await store.service.setBinding("test.two-key", "Mod+Shift+N");
  assert.equal(values["test.two-key"], "Mod+Shift+N");
  assert.equal(store.service.getSnapshot().bindings[1].customized, true);
  await assert.rejects(store.service.setBinding("test.two-key", "Ctrl+S"), error => {
    assert.equal(error.name, "ShortcutConflictError");
    assert.equal(error.bindingId, "test.two-key");
    assert.deepEqual(Array.from(error.conflictingBindingIds), ["test.one-key"]);
    return true;
  });
  await assert.rejects(store.service.setBinding("test.two-key", "Mod+Shift+X"), /disk full/);
  assert.equal(store.service.getShortcut("test.two"), "Ctrl + Shift + N");
  await store.service.resetBinding("test.two-key");
  assert.equal(values["test.two-key"], undefined);
  assert.equal(store.service.getSnapshot().bindings[1].customized, false);
  store.dispose();
});

test("shortcut settings preserve failed changes for retry and show conflicts separately", async () => {
  const f = fixture();
  const {ShortcutConflictError} = f.load(resolve(sdk, "shortcuts.ts"));
  const {createShortcutSettingsModel} = f.load(resolve(source, "plugins/shortcuts/shortcutSettingsModel.ts"));
  let diskFails = true;
  const values = {};
  const model = createShortcutSettingsModel({
    async setBinding(id, keys) {
      if (id === "conflict") throw new ShortcutConflictError(id, "application", keys, ["occupied"]);
      if (diskFails) throw new Error("disk unavailable");
      values[id] = keys;
    },
    async resetBinding(id) { delete values[id]; },
  });
  assert.equal(await model.set("first", "Mod+K"), false);
  assert.equal(await model.set("conflict", "Mod+S"), false);
  assert.deepEqual(Array.from(model.getSnapshot().failures, item => item.kind), ["save", "conflict"]);
  assert.deepEqual(Array.from(model.getSnapshot().failures[1].conflictingBindingIds), ["occupied"]);
  diskFails = false;
  assert.equal(await model.retry("first"), true);
  assert.equal(values.first, "Mod+K");
  assert.deepEqual(Array.from(model.getSnapshot().failures, item => item.kind), ["conflict"]);
  model.clearFailure("conflict");
  assert.equal(model.getSnapshot().failures.length, 0);
  await model.dispose();
});

test("shortcut shutdown waits for already accepted binding changes", async () => {
  const {createShortcutsStore} = fixture().load(resolve(source, "plugins/shortcuts/shortcutsStore.ts"));
  let release;
  const gate = new Promise(resolvePromise => { release = resolvePromise; });
  const values = {};
  const store = createShortcutsStore({getOverrides: () => values, isMac: () => false, async persist(id, keys) {
    if (id === "test.one-key") await gate;
    values[id] = keys;
  }});
  store.service.registerScope({id: "application", active: () => true});
  for (const id of ["one", "two"]) store.service.registerCommand({id: `test.${id}`, title: id, category: "测试", run() {}});
  store.service.registerBinding({id: "test.one-key", commandId: "test.one", scopeId: "application", keys: "Mod+S"});
  const removeSecond = store.service.registerBinding({id: "test.two-key", commandId: "test.two", scopeId: "application", keys: "Mod+N"});
  const first = store.service.setBinding("test.one-key", "Mod+Shift+S");
  const second = store.service.setBinding("test.two-key", "Mod+Shift+N");
  removeSecond();
  let stopped = false;
  const stop = store.dispose().then(() => { stopped = true; });
  await assert.rejects(store.service.setBinding("test.two-key", "Mod+K"), /no longer active/);
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([first, second, stop]);
  assert.equal(values["test.one-key"], "Mod+Shift+S");
  assert.equal(values["test.two-key"], "Mod+Shift+N", "an accepted change survives its contributor's shutdown");
  assert.equal(stopped, true);
  assert.throws(() => store.service.getSnapshot(), /no longer active/);
});

test("a queued change cannot overwrite a replacement binding with the same id", async () => {
  const {createShortcutsStore} = fixture().load(resolve(source, "plugins/shortcuts/shortcutsStore.ts"));
  let release;
  const gate = new Promise(resolvePromise => { release = resolvePromise; });
  const values = {};
  const store = createShortcutsStore({getOverrides: () => values, isMac: () => false, async persist(id, keys) {
    if (id === "test.one-key") await gate;
    values[id] = keys;
  }});
  store.service.registerScope({id: "application", active: () => true});
  for (const id of ["one", "two"]) store.service.registerCommand({id: `test.${id}`, title: id, category: "测试", run() {}});
  store.service.registerBinding({id: "test.one-key", commandId: "test.one", scopeId: "application", keys: "Mod+S"});
  const remove = store.service.registerBinding({id: "test.two-key", commandId: "test.two", scopeId: "application", keys: "Mod+N"});
  const first = store.service.setBinding("test.one-key", "Mod+Shift+S");
  const second = store.service.setBinding("test.two-key", "Mod+Shift+N");
  remove();
  store.service.registerBinding({id: "test.two-key", commandId: "test.two", scopeId: "application", keys: "Mod+K"});
  release();
  await first;
  await assert.rejects(second, /replaced before saving/);
  assert.equal(values["test.two-key"], undefined);
  await store.dispose();
});

test("plugin uses ConfigService, installs one wrapper, and releases registration on shutdown", async () => {
  const f = fixture();
  const plugin = f.shortcutsPlugin.createShortcutsPlugin();
  await plugin.activate(f.context);
  const service = f.context.services.get(f.load(resolve(sdk, "shortcuts.ts")).shortcutsKey);
  assert.ok(service);
  assert.equal(f.wrappers.size, 1);
  assert.equal(f.sections.get("shortcuts.keymap").render().props.shortcuts, service);
  service.registerCommand({id: "test.persist", title: "持久化", category: "测试", run() {}});
  service.registerBinding({id: "test.persist-key", commandId: "test.persist", scopeId: "application", keys: "Mod+S"});
  await service.setBinding("test.persist-key", "Mod+Shift+S");
  const item = f.shortcutsPlugin.shortcutOverridesConfig;
  assert.equal(f.config.service.getSnapshot(item)["test.persist-key"], "Mod+Shift+S");
  assert.equal(f.writes.length, 1);
  await plugin.deactivate();
  assert.equal(f.wrappers.size, 0);
  assert.equal(f.sections.size, 0);
  assert.throws(() => f.config.service.getSnapshot(item), /not registered/);
  await f.config.dispose();
});

test("shortcut plugin withdraws its settings contribution and waits for writes before unregistering config", async () => {
  const f = fixture();
  let release;
  let started;
  const gate = new Promise(resolvePromise => { release = resolvePromise; });
  const saving = new Promise(resolvePromise => { started = resolvePromise; });
  const get = f.context.get.bind(f.context);
  f.context.get = key => key === f.sdkConfig.configKey ? {
    ...f.config.service,
    async set(item, value) { started(); await gate; await f.config.service.set(item, value); },
  } : get(key);
  const plugin = f.shortcutsPlugin.createShortcutsPlugin();
  await plugin.activate(f.context);
  const service = f.context.services.get(f.load(resolve(sdk, "shortcuts.ts")).shortcutsKey);
  service.registerCommand({id: "test.pending", title: "保存中", category: "测试", run() {}});
  service.registerBinding({id: "test.pending-key", commandId: "test.pending", scopeId: "application", keys: "Mod+S"});
  const write = service.setBinding("test.pending-key", "Mod+Shift+S");
  await saving;
  let stopped = false;
  const stop = plugin.deactivate().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(f.sections.size, 0, "the contributed UI is withdrawn before its service stops");
  assert.equal(stopped, false, "shutdown waits for the accepted configuration write");
  release();
  await Promise.all([write, stop]);
  assert.equal(f.writes.at(-1)["shortcuts.bindings"]["test.pending-key"], "Mod+Shift+S");
  assert.throws(() => f.config.service.getSnapshot(f.shortcutsPlugin.shortcutOverridesConfig), /not registered/);
  await f.config.dispose();
});

test("shortcut plugin cleans its config if settings contribution fails during activation", async () => {
  const f = fixture();
  const get = f.context.get.bind(f.context);
  const {settingsKey} = f.load(resolve(sdk, "settings.ts"));
  f.context.get = key => key === settingsKey ? {registerSection() { throw new Error("cannot register settings"); }} : get(key);
  const plugin = f.shortcutsPlugin.createShortcutsPlugin();
  await assert.rejects(plugin.activate(f.context), /cannot register settings/);
  await plugin.deactivate();
  assert.equal(f.wrappers.size, 0);
  assert.throws(() => f.config.service.getSnapshot(f.shortcutsPlugin.shortcutOverridesConfig), /not registered/);
  await f.config.dispose();
});

test("shortcut activation reports both registration and cleanup failures", async () => {
  const f = fixture();
  const get = f.context.get.bind(f.context);
  const {settingsKey} = f.load(resolve(sdk, "settings.ts"));
  f.context.get = key => {
    if (key === settingsKey) return {registerSection() { throw new Error("settings registration failed"); }};
    if (key === f.sdkConfig.configKey) return {...f.config.service, register(item) {
      const remove = f.config.service.register(item);
      return () => { remove(); throw new Error("config cleanup failed"); };
    }};
    return get(key);
  };
  const plugin = f.shortcutsPlugin.createShortcutsPlugin();
  await assert.rejects(plugin.activate(f.context), error => {
    assert.equal(error.name, "ShortcutActivationError");
    assert.match(error.activationError.message, /settings registration failed/);
    assert.match(error.cleanupError.errors[0].message, /config cleanup failed/);
    return true;
  });
  await plugin.deactivate();
  await f.config.dispose();
});

test("removing a parent scope is safe and leaves its descendants inactive until the parent returns", async () => {
  const {store} = createStore();
  let calls = 0;
  store.service.registerScope({id: "application", active: () => true});
  const removeWorkbench = store.service.registerScope({id: "workbench", parentId: "application", active: () => true});
  store.service.registerScope({id: "project-tree", parentId: "workbench", active: () => true});
  store.service.registerCommand({id: "test.tree", title: "工程树", category: "测试", run() { calls++; }});
  store.service.registerBinding({id: "test.tree-key", commandId: "test.tree", scopeId: "project-tree", keys: "F2"});
  removeWorkbench();
  const key = event("F2");
  assert.equal(store.handleKeyDown(key, context()), false);
  assert.equal(key.prevented, false);
  store.service.registerScope({id: "workbench", parentId: "application", active: () => true});
  store.handleKeyDown(event("F2"), context());
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(calls, 1);
  store.dispose();
});
