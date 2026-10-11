import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

// Each fixture gets a fresh module graph so its EngineCore and themeKey share one identity,
// while globals and module-level theme state remain isolated from other cases.
function fixture({ saved = null, system = "dark", nativeSetError = false, nativeSetGate = null, nativeListenerGate = null } = {}) {
  const storageKey = "lodestory.theme-mode";
  const values = new Map(saved === null ? [] : [[storageKey, saved]]);
  const controls = { system, writeError: false, nativeSetError };
  const windowListeners = new Map();
  const mediaListeners = new Set();
  const nativeListeners = new Set();
  const channels = [];
  const nativeCalls = [];
  let nativeTheme = system;
  let unlistenCalls = 0;

  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (controls.writeError) throw new Error("storage unavailable");
      values.set(key, value);
    },
  };
  const media = {
    get matches() { return controls.system === "light"; },
    addEventListener(_name, listener) { mediaListeners.add(listener); },
    removeEventListener(_name, listener) { mediaListeners.delete(listener); },
  };
  const window = {
    localStorage: storage,
    matchMedia() { return media; },
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set());
      windowListeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { windowListeners.get(name)?.delete(listener); },
  };
  const appWindow = {
    async setTheme(mode) {
      nativeCalls.push(mode);
      if (nativeSetGate) await nativeSetGate;
      if (controls.nativeSetError) throw new Error("native theme unavailable");
      nativeTheme = mode ?? controls.system;
    },
    async theme() { return nativeTheme; },
    async onThemeChanged(listener) {
      if (nativeListenerGate) await nativeListenerGate;
      nativeListeners.add(listener);
      return () => {
        unlistenCalls += 1;
        nativeListeners.delete(listener);
      };
    },
  };
  class Channel {
    onmessage = null;
    closed = false;
    messages = [];
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(message) { this.messages.push(message); }
    close() { this.closed = true; }
  }

  const modules = new Map();
  function resolveModule(fromPath, specifier) {
    const base = resolve(dirname(fromPath), specifier);
    const candidates = [base, `${base}.ts`, resolve(base, "index.ts")];
    const path = candidates.find((candidate) => {
      try { return readFileSync(candidate, "utf8") !== undefined; }
      catch { return false; }
    });
    if (!path) throw new Error(`Cannot resolve ${specifier} from ${fromPath}`);
    return path;
  }
  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      require(specifier) {
        if (specifier === "@tauri-apps/api/core") return { isTauri: () => true };
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        return load(resolveModule(path, specifier));
      },
      window,
      document: { documentElement: { dataset: {}, style: { removeProperty() {} } } },
      BroadcastChannel: Channel,
    }, { filename: path });
    return exports;
  }

  const engine = load(resolve(sourceRoot, "plugin-core/EngineCore.ts"));
  const contract = load(resolve(sourceRoot, "theme/themeService.ts"));
  const pluginModule = load(resolve(sourceRoot, "theme/themePlugin.ts"));
  return {
    core: new engine.EngineCore(),
    EngineCore: engine.EngineCore,
    PluginActivationError: engine.PluginActivationError,
    createThemePlugin: pluginModule.createThemePlugin,
    themeKey: contract.themeKey,
    controls,
    values,
    channels,
    mediaListeners,
    nativeListeners,
    nativeCalls,
    get unlistenCalls() { return unlistenCalls; },
    windowListenerCount(name) { return windowListeners.get(name)?.size ?? 0; },
  };
}

test("theme capability stays unavailable until native initialization finishes", async () => {
  const nativeReady = deferred();
  const f = fixture({ nativeSetGate: nativeReady.promise });
  const plugin = f.createThemePlugin();
  const mounting = f.core.mount(plugin);
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  nativeReady.resolve();
  await mounting;
  assert.equal(typeof f.core.get(f.themeKey).getSnapshot, "function");
  await f.core.unmount("theme");
});

test("registered theme service switches, notifies, cancels, retries, and unmounts cleanly", async () => {
  const f = fixture();
  const plugin = f.createThemePlugin();
  await f.core.mount(plugin);
  const service = f.core.get(f.themeKey);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => { notifications += 1; });

  service.setMode("light");
  assert.equal(service.getSnapshot().mode, "light");
  assert.equal(service.getSnapshot().resolvedTheme, "light");
  assert.equal(notifications, 1);
  unsubscribe();
  service.setMode("dark");
  assert.equal(notifications, 1);

  f.controls.writeError = true;
  service.setMode("light");
  assert.equal(service.getSnapshot().persistenceError, true);
  f.controls.writeError = false;
  service.retry();
  await Promise.resolve();
  assert.equal(service.getSnapshot().persistenceError, false);
  assert.equal(f.values.get("lodestory.theme-mode"), "light");

  await f.core.unmount("theme");
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.nativeListeners.size, 0);
  plugin.deactivate();
  assert.equal(f.unlistenCalls, 1);

  await f.core.mount(plugin);
  assert.equal(f.core.get(f.themeKey).getSnapshot().mode, "light");
  assert.equal(f.mediaListeners.size, 1);
  await f.core.unmount("theme");
  assert.equal(f.channels[1].closed, true);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 2);
});

test("capability commit conflict fails activation and cleans theme platform resources", async () => {
  const f = fixture();
  const conflictingProvider = {
    id: "existing-theme",
    requires: [],
    provides: [f.themeKey],
    activate(context) {
      context.provide(f.themeKey, {
        getSnapshot() {}, subscribe() {}, setMode() {}, retry() {},
      });
    },
  };
  await f.core.mount(conflictingProvider);

  await assert.rejects(f.core.mount(f.createThemePlugin()), /already registered/);
  assert.equal(f.core.isMounted("theme"), false);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(typeof f.core.get(f.themeKey).getSnapshot, "function");
  await f.core.unmount("existing-theme");
});

test("native listener resolving after unmount is immediately removed", async () => {
  const nativeRegistration = deferred();
  const f = fixture({ nativeListenerGate: nativeRegistration.promise });
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.nativeListeners.size, 0);
  await f.core.unmount("theme");

  nativeRegistration.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 1);
});

test("native setTheme failure is retained in the snapshot without failing plugin mount", async () => {
  const f = fixture({ nativeSetError: true });
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.core.isMounted("theme"), true);
  assert.equal(f.core.get(f.themeKey).getSnapshot().windowError, true);
  await f.core.unmount("theme");
});
