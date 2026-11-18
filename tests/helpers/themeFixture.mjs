import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createSdkLoader } from "./sdkFixture.mjs";
import { resolveUiPackageImport } from "./uiPackageFixture.mjs";

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
export function fixture({ saved = null, preference, system = "dark", desktop = true, readError = false, nativeSetError = false, nativeSetGate = null, nativeListenerGate = null } = {}) {
  const storageKey = "lodestory.theme-mode";
  const values = new Map(saved === null ? [] : [[storageKey, saved]]);
  if (preference !== undefined) values.set("lodestory.theme-preference", typeof preference === "string" ? preference : JSON.stringify(preference));
  const controls = { system, writeError: false, readError, nativeSetError, nativeDelay: nativeSetGate, uiDisposeError: false };
  const rootAttributes = new Map();
  const root = {
    dataset: {},
    getAttribute(name) { return rootAttributes.get(name) ?? null; },
    setAttribute(name, value) { rootAttributes.set(name, value); },
    removeAttribute(name) { rootAttributes.delete(name); },
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    },
  };
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
    getItem(key) { if (controls.readError) throw new Error("storage unavailable"); return values.get(key) ?? null; },
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
      if (controls.nativeDelay) await controls.nativeDelay;
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
  const sdk = createSdkLoader({ modules });
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
    if (path.endsWith(".json")) {
      const data = JSON.parse(source);
      return { ...data, __esModule: true, default: data };
    }
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
        const uiImport = resolveUiPackageImport(specifier, load);
        if (uiImport.handled) return uiImport.value;
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relative(sourceRoot, path));
        if (specifier === "@tauri-apps/api/core") return { isTauri: () => desktop };
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        if (specifier === "react") return React;
        if (specifier === "react/jsx-runtime") return jsxRuntime;
        if (specifier === "react/jsx-dev-runtime") return jsxDevRuntime;
        if (specifier === "react-dom/client") return { createRoot() { throw new Error("Unexpected React root creation in theme fixture."); } };
        return load(resolveModule(path, specifier));
      },
      window,
      document: { documentElement: root },
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
  const contract = sdk.requireSdk("@lodestory/sdk/theme");
  const uiContract = sdk.requireSdk("@lodestory/sdk/ui");
  const themeStore = load(resolve(sourceRoot, "plugins/theme/themeStore.ts"));
  const builtin = load(resolve(sourceRoot, "plugins/builtin-themes/builtinThemesPlugin.ts"));
  const config = JSON.parse(readFileSync(resolve(sourceRoot, "plugins/theme/theme-config.json"), "utf8"));
  const originalCreateThemeStore = themeStore.createThemeStore;
  let currentStore;
  themeStore.createThemeStore = defaults => {
    const store = originalCreateThemeStore(defaults);
    const dispose = store.dispose;
    store.dispose = () => {
      uiLifecycle.push("stop-theme-sync");
      dispose();
    };
    currentStore = store;
    return store;
  };
  const themeUi = load(resolve(sourceRoot, "plugins/theme/ThemeProvider.tsx"));
  const pluginModule = load(resolve(sourceRoot, "plugins/theme/themePlugin.ts"));
  let uiService;
  return {
    React,
    get api() {
      if (!currentStore) {
        const store = themeStore.createThemeStore(config);
        builtin.createBuiltinThemesPlugin().activate({ get: () => ({ registerTheme: store.registerTheme }) });
        store.startThemeSync();
      }
      return currentStore;
    },
    root,
    nativeTheme: () => nativeTheme,
    changeSystem(type) {
      controls.system = type;
      mediaListeners.forEach(listener => listener());
      nativeListeners.forEach(listener => listener({ payload: type }));
    },
    storageEvent(value, storageArea = storage) {
      windowListeners.get("storage")?.forEach(listener => listener({ key: "lodestory.theme-preference", newValue: value, storageArea }));
    },
    core: new TrackedEngineCore(),
    EngineCore: TrackedEngineCore,
    createdCores,
    PluginActivationError: engine.PluginActivationError,
    PluginBatchActivationError: engine.PluginBatchActivationError,
    createThemePlugin: pluginModule.createThemePlugin,
    config,
    createBuiltinThemesPlugin: builtin.createBuiltinThemesPlugin,
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
    async provideThemes(definitions) {
      const removers = [];
      await this.core.mount(definitions ? {
        id: "test-themes", requires: [contract.themeKey], provides: [],
        activate(context) {
          for (const definition of definitions) removers.push(context.get(contract.themeKey).registerTheme(definition));
        },
        deactivate() { for (const remove of removers.splice(0).reverse()) remove(); },
      } : builtin.createBuiltinThemesPlugin());
    },
    async prepareUi() {
      for (const { wrapper } of uiRegistrations.filter(item => item.active).sort((a, b) => a.wrapper.order - b.wrapper.order)) await wrapper.prepare?.();
    },
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
              const remove = () => {
                if (!record.active) return;
                record.active = false;
                uiLifecycle.push(`remove:${wrapper.id}`);
                if (controls.uiDisposeError) throw new Error("UI wrapper disposer failed");
              };
              return Object.assign(remove, {associate() {}, check() {}, withdraw() {}});
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
    requireSdk(specifier) { return sdk.requireSdk(specifier); },
    sdkImports: sdk.imports,
    sdkEvaluatedModules: sdk.evaluatedModules,
    get unlistenCalls() { return unlistenCalls; },
    windowListenerCount(name) { return windowListeners.get(name)?.size ?? 0; },
  };
}
