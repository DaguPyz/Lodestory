import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const React = requireFromHere("react");
const jsxRuntime = requireFromHere("react/jsx-runtime");
const jsxDevRuntime = requireFromHere("react/jsx-dev-runtime");

export function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

// Each fixture gets a fresh module graph so EngineCore and themeKey share one identity,
// while globals and module-level theme state remain isolated from other cases.
export function fixture({ saved = null, system = "dark", nativeSetError = false, nativeSetGate = null, nativeListenerGate = null } = {}) {
  const storageKey = "lodestory.theme-mode";
  const values = new Map(saved === null ? [] : [[storageKey, saved]]);
  const controls = { system, writeError: false, nativeSetError, uiDisposeError: false };
  const windowListeners = new Map();
  const mediaListeners = new Set();
  const nativeListeners = new Set();
  const channels = [];
  const nativeCalls = [];
  const createdCores = [];
  const uiRegistrations = [];
  const uiLifecycle = [];
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
    const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
    const path = candidates.find((candidate) => {
      try { return readFileSync(candidate, "utf8") !== undefined; }
      catch { return false; }
    });
    if (!path) throw new Error(`Cannot resolve ${specifier} from ${fromPath}`);
    return path;
  }
  function load(path) {
    if (path.endsWith(".css")) return {};
    const cached = modules.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        ...(path.endsWith(".tsx") ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      require(specifier) {
        if (specifier === "@tauri-apps/api/core") return { isTauri: () => true };
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        if (specifier === "react") return React;
        if (specifier === "react/jsx-runtime") return jsxRuntime;
        if (specifier === "react/jsx-dev-runtime") return jsxDevRuntime;
        if (specifier === "react-dom/client") return { createRoot() { throw new Error("Unexpected React root creation in theme fixture."); } };
        return load(resolveModule(path, specifier));
      },
      window,
      document: { documentElement: { dataset: {}, style: { removeProperty() {} } } },
      BroadcastChannel: Channel,
    }, { filename: path });
    return exports;
  }

  const engine = load(resolve(sourceRoot, "plugin-core/EngineCore.ts"));
  const BaseEngineCore = engine.EngineCore;
  class TrackedEngineCore extends BaseEngineCore {
    constructor(...args) {
      super(...args);
      createdCores.push(this);
    }
  }
  // Runtime imports resolve to this same cached export object, so its core is inspectable too.
  engine.EngineCore = TrackedEngineCore;
  const contract = load(resolve(sourceRoot, "plugins/theme/themeService.ts"));
  const uiContract = load(resolve(sourceRoot, "plugins/ui/uiService.ts"));
  const themeStore = load(resolve(sourceRoot, "plugins/theme/themeStore.ts"));
  const originalStartThemeSync = themeStore.startThemeSync;
  themeStore.startThemeSync = () => {
    const stop = originalStartThemeSync();
    return () => {
      uiLifecycle.push("stop-theme-sync");
      stop();
    };
  };
  const themeUi = load(resolve(sourceRoot, "plugins/theme/ThemeProvider.tsx"));
  const pluginModule = load(resolve(sourceRoot, "plugins/theme/themePlugin.ts"));
  let uiService;
  return {
    React,
    core: new TrackedEngineCore(),
    EngineCore: TrackedEngineCore,
    createdCores,
    PluginActivationError: engine.PluginActivationError,
    PluginBatchActivationError: engine.PluginBatchActivationError,
    createThemePlugin: pluginModule.createThemePlugin,
    themeKey: contract.themeKey,
    uiKey: uiContract.uiKey,
    ThemeProvider: themeUi.ThemeProvider,
    useThemeService: themeUi.useThemeService,
    controls,
    values,
    channels,
    mediaListeners,
    nativeListeners,
    nativeCalls,
    uiRegistrations,
    uiLifecycle,
    async provideUi() {
      await this.core.mount({
        id: "test-ui",
        requires: [],
        provides: [uiContract.uiKey],
        activate(context) {
          uiService = {
            addWrapper(wrapper) {
              const record = { kind: "wrapper", wrapper, active: true };
              uiRegistrations.push(record);
              uiLifecycle.push(`add:${wrapper.id}`);
              return () => {
                if (!record.active) return;
                record.active = false;
                uiLifecycle.push(`remove:${wrapper.id}`);
                if (controls.uiDisposeError) throw new Error("UI wrapper disposer failed");
              };
            },
          };
          context.provide(uiContract.uiKey, uiService);
        },
      });
      return uiService;
    },
    renderToStaticMarkup(element) {
      return requireFromHere("react-dom/server").renderToStaticMarkup(element);
    },
    loadModule(relativePath) { return load(resolve(sourceRoot, relativePath)); },
    get unlistenCalls() { return unlistenCalls; },
    windowListenerCount(name) { return windowListeners.get(name)?.size ?? 0; },
  };
}
