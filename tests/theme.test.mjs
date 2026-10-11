import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/theme/themeStore.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const bootstrap = await readFile(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
const key = "lodestory.theme-mode";

function fixture({ saved = null, system = "light", desktop = false } = {}) {
  const values = new Map(saved === null ? [] : [[key, saved]]);
  const windowListeners = new Map();
  const mediaListeners = new Set();
  const root = { dataset: {}, style: { removeProperty() {} } };
  const controls = { writeError: false, readError: false, system, nativeDelay: null };
  const nativeCalls = [];
  const nativeListeners = new Set();
  const channels = [];
  let nativeTheme = system;
  const storage = {
    getItem(name) { if (controls.readError) throw new Error("unavailable"); return values.get(name) ?? null; },
    setItem(name, value) { if (controls.writeError) throw new Error("unavailable"); values.set(name, value); },
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
  const nativeWindow = {
    async setTheme(mode) {
      nativeCalls.push(mode);
      if (controls.nativeDelay) await controls.nativeDelay;
      nativeTheme = mode ?? controls.system;
    },
    async theme() { return nativeTheme; },
    async onThemeChanged(listener) {
      nativeListeners.add(listener);
      return () => nativeListeners.delete(listener);
    },
  };
  class Channel {
    onmessage = null;
    messages = [];
    closed = false;
    constructor() { channels.push(this); }
    postMessage(message) { this.messages.push(message); }
    close() { this.closed = true; }
  }
  const api = {};
  vm.runInNewContext(compiled, {
    exports: api,
    require(name) {
      if (name === "@tauri-apps/api/core") return { isTauri: () => desktop };
      if (name === "@tauri-apps/api/window") return { getCurrentWindow: () => nativeWindow };
      throw new Error("Unexpected import: " + name);
    },
    window,
    document: { documentElement: root },
    BroadcastChannel: Channel,
  }, { filename: "themeStore.js" });
  return {
    api, controls, root, values, nativeCalls, channels, mediaListeners, nativeListeners,
    changeSystem(theme) {
      controls.system = theme;
      mediaListeners.forEach((listener) => listener());
      nativeListeners.forEach((listener) => listener({ payload: theme }));
    },
    storageEvent(value, storageArea = storage) {
      windowListeners.get("storage")?.forEach((listener) => listener({ key, newValue: value, storageArea }));
    },
    nativeTheme: () => nativeTheme,
  };
}

test("first paint uses the saved mode and safe fallbacks", () => {
  const cases = [
    { saved: null, system: "light", expected: "dark" },
    { saved: "light", system: "dark", expected: "light" },
    { saved: "dark", system: "light", expected: "dark" },
    { saved: "system", system: "light", expected: "light" },
    { saved: "system", system: "dark", expected: "dark" },
    { saved: "unknown", system: "light", expected: "dark" },
    { saved: "system", system: "light", mediaError: true, expected: "dark" },
    { saved: "light", system: "light", readError: true, expected: "dark" },
  ];
  for (const entry of cases) {
    const root = { dataset: {}, style: {} };
    vm.runInNewContext(bootstrap, {
      document: { documentElement: root },
      window: {
        localStorage: { getItem() { if (entry.readError) throw new Error("blocked"); return entry.saved; } },
        matchMedia() { if (entry.mediaError) throw new Error("unsupported"); return { matches: entry.system === "light" }; },
      },
    });
    assert.equal(root.dataset.uiTheme, entry.expected);
    assert.equal(root.style.colorScheme, entry.expected);
  }
});

test("manual mode ignores later system appearance changes", () => {
  const f = fixture({ saved: "light" });
  const stop = f.api.startThemeSync();
  f.api.setThemeMode("dark");
  f.changeSystem("light");
  assert.equal(f.api.getThemeSnapshot().mode, "dark");
  assert.equal(f.root.dataset.uiTheme, "dark");
  assert.equal(f.values.get(key), "dark");
  stop();
});

test("system appearance changes keep the selected mode as system", () => {
  const f = fixture({ saved: "system", system: "light" });
  const stop = f.api.startThemeSync();
  f.changeSystem("dark");
  assert.equal(f.api.getThemeSnapshot().mode, "system");
  assert.equal(f.api.getThemeSnapshot().resolvedTheme, "dark");
  assert.equal(f.root.style.colorScheme, "dark");
  stop();
  f.changeSystem("light");
  assert.equal(f.api.getThemeSnapshot().resolvedTheme, "dark");
});

test("save failure preserves the session choice and retry clears the error", () => {
  const f = fixture();
  const stop = f.api.startThemeSync();
  f.controls.writeError = true;
  f.api.setThemeMode("light");
  assert.equal(f.api.getThemeSnapshot().resolvedTheme, "light");
  assert.equal(f.api.getThemeSnapshot().persistenceError, true);
  assert.equal(f.channels[0].messages[0].persistenceError, true);
  f.controls.writeError = false;
  f.api.retryTheme();
  assert.equal(f.api.getThemeSnapshot().persistenceError, false);
  assert.equal(f.values.get(key), "light");
  stop();
});

test("storage synchronizes preferences and ignores other storage areas", () => {
  const f = fixture();
  const stop = f.api.startThemeSync();
  f.storageEvent("light", {});
  assert.equal(f.api.getThemeSnapshot().mode, "dark");
  f.storageEvent("light");
  assert.equal(f.api.getThemeSnapshot().mode, "light");
  f.storageEvent("unknown");
  assert.equal(f.api.getThemeSnapshot().mode, "dark");
  stop();
});

test("cross-window messages validate modes and preserve failed save state", () => {
  const f = fixture();
  const stop = f.api.startThemeSync();
  f.channels[0].onmessage({ data: { mode: "invalid" } });
  assert.equal(f.api.getThemeSnapshot().mode, "dark");
  f.channels[0].onmessage({ data: { mode: "light", persistenceError: true } });
  assert.equal(f.api.getThemeSnapshot().mode, "light");
  assert.equal(f.api.getThemeSnapshot().persistenceError, true);
  stop();
  assert.equal(f.channels[0].closed, true);
});

test("desktop system mode releases the native override before resolving the theme", async () => {
  const f = fixture({ saved: "dark", desktop: true, system: "light" });
  const stop = f.api.startThemeSync();
  await f.api.whenNativeThemeReady();
  f.api.setThemeMode("system");
  await f.api.whenNativeThemeReady();
  assert.equal(f.nativeCalls.at(-1), null);
  assert.equal(f.nativeTheme(), "light");
  assert.equal(f.api.getThemeSnapshot().mode, "system");
  assert.equal(f.api.getThemeSnapshot().resolvedTheme, "light");
  stop();
});

test("a delayed native request cannot overwrite a newer selection", async () => {
  const f = fixture({ desktop: true });
  const stop = f.api.startThemeSync();
  await f.api.whenNativeThemeReady();
  f.nativeCalls.length = 0;
  let release;
  f.controls.nativeDelay = new Promise((resolve) => { release = resolve; });
  f.api.setThemeMode("light");
  await Promise.resolve();
  f.api.setThemeMode("dark");
  release();
  await f.api.whenNativeThemeReady();
  assert.equal(f.nativeTheme(), "dark");
  assert.equal(f.root.dataset.uiTheme, "dark");
  assert.equal(f.nativeCalls.at(-1), "dark");
  stop();
});

