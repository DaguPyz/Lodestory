import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

export function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

export function createMainFixture({ tauri = true, nativeSetGate = null, nativeSetError = false } = {}) {
  const modules = new Map();
  const createdCores = [];
  const rootCalls = [];
  const moduleImports = [];
  const catalogPluginIds = [];
  const lifecycle = [];
  const nativeCalls = [];
  const mediaListeners = new Set();
  const windowListeners = new Map();
  const nativeListeners = new Set();
  const channels = [];
  const logs = [];
  const storage = new Map();
  const rootElement = { children: [], textContent: "", innerHTML: "", append(child) { this.children.push(child); } };
  rootElement.replaceChildren = (...children) => { rootElement.children = children; };
  const document = {
    documentElement: { dataset: {}, style: { removeProperty() {} } },
    getElementById(id) { return id === "root" ? rootElement : null; },
    createElement(tagName) {
      return {
        tagName,
        textContent: "",
        type: "",
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { this.children = [...(this.children ?? []), ...children]; },
        addEventListener(name, listener) { this[`on${name}`] = listener; },
        click() { this.onclick?.(); },
      };
    },
  };
  const window = {
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    matchMedia() {
      return {
        matches: false,
        addEventListener(_event, listener) { mediaListeners.add(listener); },
        removeEventListener(_event, listener) {
          mediaListeners.delete(listener);
          logs.push("media.remove");
        },
      };
    },
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set());
      windowListeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      windowListeners.get(name)?.delete(listener);
      logs.push(`window.remove:${name}`);
    },
    location: { reloadCalls: 0, reload() { this.reloadCalls += 1; } },
  };
  const appWindow = {
    async setTheme(mode) {
      nativeCalls.push(mode);
      if (nativeSetGate) await nativeSetGate;
      if (nativeSetError) throw new Error("native theme unavailable");
    },
    async theme() { return "dark"; },
    async onThemeChanged(listener) {
      nativeListeners.add(listener);
      return () => {
        logs.push("native.unlisten");
        nativeListeners.delete(listener);
      };
    },
  };
  class Channel {
    onmessage = null;
    closed = false;
    constructor(name) { this.name = name; channels.push(this); }
    postMessage() {}
    close() { this.closed = true; logs.push("channel.close"); }
  }

  const React = {
    StrictMode: Symbol("StrictMode"),
    createElement(type, props, ...children) {
      const nextProps = { ...(props ?? {}) };
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps };
    },
  };
  const ReactDOM = {
    createRoot(container, options) {
      rootCalls.push({ container, options });
      if (faults.createRootError) throw faults.createRootError;
      const root = {
        container,
        options,
        render(tree) {
          logs.push("root.render");
          if (faults.uncaughtErrorDuringRender) {
            options?.onUncaughtError?.(faults.uncaughtErrorDuringRender);
          }
          if (faults.renderError) throw faults.renderError;
          this.tree = tree;
        },
        unmount() {
          logs.push("root.unmount");
          if (faults.unmountError) throw faults.unmountError;
        },
      };
      roots.push(root);
      return root;
    },
  };
  const roots = [];
  const faults = {};
  const components = {
    App: function App() {},
    ContextMenuProvider: function ContextMenuProvider() {},
    ThemeProvider: function ThemeProvider() {},
  };
  let activationError;
  let cleanupError;
  let omitThemeService = false;

  function resolveLocal(fromPath, specifier) {
    if (!specifier.startsWith(".")) throw new Error(`Unexpected local import '${specifier}' from ${fromPath}`);
    const base = resolve(dirname(fromPath), specifier);
    const candidates = [base, `${base}.tsx`, `${base}.ts`, `${base}.css`, resolve(base, "index.tsx"), resolve(base, "index.ts")];
    const path = candidates.find((candidate) => {
      try { readFileSync(candidate, "utf8"); return true; }
      catch { return false; }
    });
    if (!path) throw new Error(`Cannot resolve '${specifier}' from ${fromPath}`);
    return path;
  }

  function load(path) {
    if (path.endsWith(".css")) return {};
    const cached = modules.get(path);
    if (cached) return cached;
    const relativePath = relative(sourceRoot, path);
    if (relativePath === "App.tsx") return { __esModule: true, default: components.App };
    if (relativePath === "plugins/context-menu/ContextMenuProvider.tsx") {
      return { __esModule: true, ContextMenuProvider: components.ContextMenuProvider };
    }
    if (relativePath === "plugins/context-menu/ContextMenuRegion.tsx") return {};
    if (relativePath === "plugins/theme/ThemeProvider.tsx") {
      return { __esModule: true, ThemeProvider: components.ThemeProvider };
    }
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      console: {
        error(...args) { logs.push({ level: "error", args }); },
        warn(...args) { logs.push({ level: "warn", args }); },
      },
      document,
      window,
      BroadcastChannel: Channel,
      setTimeout,
      clearTimeout,
      Promise,
      Error,
      Symbol,
      Map,
      Set,
      Object,
      Array,
      require(specifier) {
        moduleImports.push({ from: relativePath, specifier });
        if (specifier === "react") return React;
        if (specifier === "react-dom/client") return ReactDOM;
        if (specifier === "react/jsx-runtime") {
          return {
            jsx(type, props, key) { return { type, props: props ?? {}, key }; },
            jsxs(type, props, key) { return { type, props: props ?? {}, key }; },
            Fragment: Symbol("Fragment"),
          };
        }
        if (specifier === "@tauri-apps/api/core") return { isTauri: () => tauri };
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        return load(resolveLocal(path, specifier));
      },
    }, { filename: path });

    if (relativePath === "plugin-core/EngineCore.ts") {
      const BaseEngineCore = exports.EngineCore;
      class TrackedEngineCore extends BaseEngineCore {
        constructor(...args) {
          super(...args);
          createdCores.push(this);
        }
      }
      exports.EngineCore = TrackedEngineCore;
    }
    if (relativePath === "plugin-core/EventBus.ts") {
      const emit = exports.EventBus.prototype.emit;
      exports.EventBus.prototype.emit = async function (key, payload) {
        if (key.id === "runtime/plugins-ready") logs.push("plugins-ready.emit");
        return emit.call(this, key, payload);
      };
    }
    if (relativePath === "plugins/theme/themePlugin.ts") {
      const createThemePlugin = exports.createThemePlugin;
      exports.createThemePlugin = () => {
        const plugin = createThemePlugin();
        const activate = plugin.activate;
        plugin.activate = async (context) => {
          const pluginContext = omitThemeService
            ? {
                ...context,
                provide(key, value) {
                  if (key.id === "app/theme") return;
                  return context.provide(key, value);
                },
              }
            : context;
          await activate(pluginContext);
          if (activationError) throw activationError;
        };
        const deactivate = plugin.deactivate;
        plugin.deactivate = () => {
          deactivate?.();
          if (cleanupError) throw cleanupError;
        };
        return plugin;
      };
    }
    if (relativePath === "app/appPlugins.ts") {
      const createAppPlugins = exports.createAppPlugins;
      exports.createAppPlugins = (...args) => {
        const plugins = createAppPlugins(...args);
        catalogPluginIds.push(...plugins.map(({ id }) => id));
        return plugins.map((plugin) => ({
          ...plugin,
          async activate(context) {
            lifecycle.push(`activate:${plugin.id}:begin`);
            logs.push(`activate:${plugin.id}:begin`);
            await plugin.activate(context);
            lifecycle.push(`activate:${plugin.id}:complete`);
            logs.push(`activate:${plugin.id}:complete`);
          },
          async deactivate() {
            lifecycle.push(`deactivate:${plugin.id}:begin`);
            logs.push(`deactivate:${plugin.id}:begin`);
            await plugin.deactivate?.();
            lifecycle.push(`deactivate:${plugin.id}:complete`);
            logs.push(`deactivate:${plugin.id}:complete`);
          },
        }));
      };
    }
    return exports;
  }

  function start() {
    load(resolve(sourceRoot, "main.tsx"));
  }

  return {
    start,
    loadModule(relativePath) { return load(resolve(sourceRoot, relativePath)); },
    React,
    ReactDOM,
    components,
    createdCores,
    moduleImports,
    catalogPluginIds,
    lifecycle,
    rootCalls,
    roots,
    rootElement,
    nativeCalls,
    channels,
    mediaListeners,
    nativeListeners,
    windowListeners,
    logs,
    faults,
    window,
    setActivationError(error, deactivateError) {
      activationError = error;
      cleanupError = deactivateError;
    },
    setCleanupError(error) { cleanupError = error; },
    omitThemeService() { omitThemeService = true; },
    getService(key) { return createdCores.at(-1)?.get(key); },
  };
}

export async function flushStartup(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}
