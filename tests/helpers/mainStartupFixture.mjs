import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createSdkLoader } from "./sdkFixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

export function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

export function createMainFixture({ tauri = true, nativeSetGate = null, nativeSetError = false, missingRoot = false, themeDefinitions = [], omitBuiltinThemes = false, preference, configBaseValues, configOverrides, configStorageReadError, configStorageWriteError, layoutFactory, additionalPlugins = [], invokeHandler, mockWorkbenchToolbar = true } = {}) {
  const modules = new Map();
  const sdk = createSdkLoader({ modules });
  const createdCores = [];
  const rootCalls = [];
  const moduleImports = [];
  const catalogPluginIds = [];
  const bodyEditorModels = new Map();
  const projectManagementModels = new Map();
  const workbenchToolbarModels = new Map();
  const appPluginsCalls = [];
  const lifecycle = [];
  const nativeCalls = [];
  const tauriCalls = [];
  const mediaListeners = new Set();
  const windowListeners = new Map();
  const closeRequestListeners = new Set();
  const nativeListeners = new Set();
  const channels = [];
  const logs = [];
  const storage = new Map(preference ? [["lodestory.theme-preference", JSON.stringify(preference)]] : []);
  if (configOverrides !== undefined) storage.set("lodestory.config-overrides", JSON.stringify(configOverrides));
  const themeApplications = [];
  const rootElement = { children: [], textContent: "", innerHTML: "", append(child) { this.children.push(child); } };
  rootElement.replaceChildren = (...children) => { rootElement.children = children; };
  const document = {
    documentElement: { dataset: {}, style: { setProperty(name, value) { if (name === "--ui-surface-workspace") themeApplications.push({ id: document.documentElement.dataset.uiThemeId, value }); }, removeProperty() {} } },
    getElementById(id) { return id === "root" && !missingRoot ? rootElement : null; },
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
      getItem(key) {
        if (key === "lodestory.config-overrides" && configStorageReadError) throw configStorageReadError;
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (key === "lodestory.config-overrides" && configStorageWriteError) throw configStorageWriteError;
        storage.set(key, value);
      },
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
    async onCloseRequested(listener) {
      closeRequestListeners.add(listener);
      return () => {
        closeRequestListeners.delete(listener);
        logs.push("window.unlisten:close-requested");
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
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useEffect() {},
    useRef(initialValue) { return {current: initialValue}; },
    useId() { return "fixture-id"; },
    createContext(defaultValue) {
      const context = { _currentValue: defaultValue };
      context.Provider = function Provider({ value, children }) {
        context._currentValue = value;
        return children;
      };
      return context;
    },
    useContext(context) { return context._currentValue; },
    createElement(type, props, ...children) {
      const nextProps = { ...(props ?? {}) };
      const key = nextProps.key;
      delete nextProps.key;
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps, ...(key !== undefined ? { key } : {}) };
    },
  };
  const ReactDOM = {
    flushSync(callback) {
      logs.push("react-dom.flushSync:start");
      try { return callback(); }
      finally { logs.push("react-dom.flushSync:end"); }
    },
    createRoot(container, options) {
      rootCalls.push({ container, options });
      if (faults.createRootError) throw faults.createRootError;
      const root = {
        container,
        options,
        renderCalls: [],
        render(tree) {
          logs.push("root.render");
          this.renderCalls.push(tree);
          if (faults.uncaughtErrorDuringRender) {
            const error = faults.uncaughtErrorDuringRender;
            faults.uncaughtErrorDuringRender = undefined;
            options?.onUncaughtError?.(error);
          }
          if (faults.renderErrorOnce) {
            const error = faults.renderErrorOnce;
            faults.renderErrorOnce = undefined;
            throw error;
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
    ErrorBoundary: function ErrorBoundary({ children }) { return children; },
    ErrorView: function ErrorView() {},
    WelcomePage: function WelcomePage() {},
    EditorPage: function EditorPage() {},
    BodyEditorContentProvider: function BodyEditorContentProvider({ workbench, models, children }) {
      const session = workbench.getSnapshot().session;
      if (session) bodyEditorModels.set(session.id, models.get(session.id));
      return children;
    },
    BodyEditor: function BodyEditor({active}) { return React.createElement("body-editor", {active}); },
    ProjectFiles: function ProjectFiles({ workbench, models, active }) {
      const session = workbench.getSnapshot().session;
      const model = session ? models.get(session.id) : undefined;
      if (session && model) projectManagementModels.set(session.id, model);
      return React.createElement("project-files", {active, model});
    },
    ProjectDialogs: function ProjectDialogs({ workbench, models, children }) {
      const session = workbench.getSnapshot().session;
      const model = session ? models.get(session.id) : undefined;
      if (session && model) projectManagementModels.set(session.id, model);
      return children ?? React.createElement("project-dialog", {model, open: model?.getSnapshot().dialogOpen ?? false});
    },
    WorkbenchToolbar: function WorkbenchToolbar({ workbench, models, active }) {
      const session = workbench.getSnapshot().session;
      const model = session ? models.get(session.id) : undefined;
      if (session && model) workbenchToolbarModels.set(session.id, model);
      return React.createElement("workbench-toolbar", {active, model});
    },
    ToolbarRecovery: function ToolbarRecovery({ workbench, models }) {
      const session = workbench.getSnapshot().session;
      const model = session ? models.get(session.id) : undefined;
      return React.createElement("toolbar-recovery", {model});
    },
    WorkbenchPage: function WorkbenchPage({ workbench, layout, active }) {
      const snapshot = workbench.getSnapshot();
      return snapshot.session ? React.createElement(layout.View, {
        key: snapshot.session.id,
        active: active && !snapshot.busy,
      }) : null;
    },
    ThemeSettingsPage: function ThemeSettingsPage() {},
    PageShell: function PageShell() {},
    ProjectPageLayout: function ProjectPageLayout() {},
    ContextMenuProvider: function ContextMenuProvider() {},
    ThemeProvider: function ThemeProvider() {},
  };
  let UiPages;
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
    if (relativePath === "plugins/welcome/WelcomePage.tsx") return { __esModule: true, WelcomePage: components.WelcomePage };
    if (relativePath === "plugins/body-editor/BodyEditorContext.tsx") return {
      __esModule: true,
      BodyEditorContentProvider: components.BodyEditorContentProvider,
    };
    if (relativePath === "plugins/body-editor/BodyEditorView.tsx") return {
      __esModule: true,
      BodyEditor: components.BodyEditor,
    };
    if (relativePath === "plugins/project-management/ProjectManagementView.tsx") return {
      __esModule: true,
      ProjectFiles: components.ProjectFiles,
      ProjectDialogs: components.ProjectDialogs,
    };
    if (relativePath === "plugins/workbench-toolbar/WorkbenchToolbar.tsx" && mockWorkbenchToolbar) return {
      __esModule: true,
      WorkbenchToolbar: components.WorkbenchToolbar,
      ToolbarRecovery: components.ToolbarRecovery,
    };
    if (relativePath === "plugins/workbench/WorkbenchPage.tsx") return { __esModule: true, WorkbenchPage: components.WorkbenchPage };
    if (relativePath === "plugins/settings/ThemeSettingsPage.tsx") return { __esModule: true, ThemeSettingsPage: components.ThemeSettingsPage };
    if (relativePath === "components/PageShell.tsx") return { __esModule: true, PageShell: components.PageShell };
    if (relativePath === "components/ProjectPageLayout.tsx") return { __esModule: true, ProjectPageLayout: components.ProjectPageLayout };
    if (relativePath === "plugins/context-menu/ContextMenuProvider.tsx") {
      return {
        __esModule: true,
        ContextMenuProvider: components.ContextMenuProvider,
        useContextMenus() { return {activate() {}, release() {}}; },
      };
    }
    if (relativePath === "plugins/context-menu/ContextMenuRegion.tsx") return {};
    if (relativePath === "plugins/theme/ThemeProvider.tsx") {
      return { __esModule: true, ThemeProvider: components.ThemeProvider };
    }
    if (relativePath === "plugins/error-ui/errorUiPlugin.tsx") {
      const { errorUiKey } = sdk.requireSdk("@lodestory/sdk/error", relativePath);
      return {
        __esModule: true,
        createErrorUiPlugin() {
          return {
            id: "error-ui",
            requires: [],
            provides: [errorUiKey],
            activate(context) {
              context.provide(errorUiKey, { ErrorBoundary: components.ErrorBoundary, ErrorView: components.ErrorView });
            },
            deactivate() {},
          };
        },
      };
    }
    const source = readFileSync(path, "utf8");
    if (path.endsWith(".json")) {
      const data = relativePath === "plugins/config/config.json" && configBaseValues !== undefined
        ? configBaseValues
        : JSON.parse(source);
      return { ...data, __esModule: true, default: data };
    }
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
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relativePath);
        if (specifier === "react") return React;
        if (specifier === "react-dom/client") return ReactDOM;
        if (specifier === "react/jsx-runtime") {
          return {
            jsx(type, props, key) { return { type, props: props ?? {}, key }; },
            jsxs(type, props, key) { return { type, props: props ?? {}, key }; },
            Fragment: Symbol("Fragment"),
          };
        }
        if (specifier === "@tauri-apps/api/core") return {
          isTauri: () => tauri,
          async invoke(command, args) {
            tauriCalls.push({ command, args });
            if (invokeHandler) return invokeHandler(command, args);
            if (command === "list_documents") return [];
            if (command === "create_document") {
              const path = [args.parentPath, args.name].filter(Boolean).join("/");
              return { path, fileName: args.name, content: "" };
            }
            if (command === "read_document") return { path: args.path, fileName: args.path.split("/").at(-1), content: "" };
            if (command === "save_document") return undefined;
            throw new Error(`Unexpected Tauri command '${command}'.`);
          },
        };
        if (specifier === "react-dom") return ReactDOM;
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        return load(resolveLocal(path, specifier));
      },
    }, { filename: path });

    if (/^plugins\/ui\/[^/]*UiPages\.tsx$/i.test(relativePath)) {
      UiPages = exports.UiPages ?? exports.default;
    }

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
      exports.createThemePlugin = (...args) => {
        const plugin = createThemePlugin(...args);
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
        appPluginsCalls.push(args);
        const plugins = createAppPlugins(...args).filter(plugin => !omitBuiltinThemes || plugin.id !== "builtin-themes")
          .map(plugin => plugin.id === "default-layout" && layoutFactory ? layoutFactory(sdk.requireSdk("@lodestory/sdk/layout")) : plugin);
        const injectedPlugins = typeof additionalPlugins === "function"
          ? additionalPlugins({ requireSdk: (specifier) => sdk.requireSdk(specifier) })
          : additionalPlugins;
        plugins.push(...injectedPlugins);
        if (themeDefinitions.length) {
          const { themeKey } = sdk.requireSdk("@lodestory/sdk/theme");
          const removers = [];
          plugins.push({
            id: "test-custom-themes", requires: [themeKey], provides: [],
            activate(context) { for (const theme of themeDefinitions) removers.push(context.get(themeKey).registerTheme(theme)); },
            deactivate() { for (const remove of removers.splice(0).reverse()) remove(); },
          });
        }
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
    requireSdk(specifier) { return sdk.requireSdk(specifier); },
    sdkImports: sdk.imports,
    sdkEvaluatedModules: sdk.evaluatedModules,
    React,
    ReactDOM,
    components,
    get UiPages() { return UiPages; },
    createdCores,
    moduleImports,
    catalogPluginIds,
    appPluginsCalls,
    lifecycle,
    rootCalls,
    roots,
    rootElement,
    nativeCalls,
    tauriCalls,
    themeApplications,
    channels,
    mediaListeners,
    nativeListeners,
    windowListeners,
    closeRequestListeners,
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
    bodyEditorModels,
    projectManagementModels,
    workbenchToolbarModels,
    async requestWindowClose() {
      let prevented = false;
      const event = { preventDefault() { prevented = true; } };
      for (const listener of [...closeRequestListeners]) await listener(event);
      return { prevented, listenerCount: closeRequestListeners.size };
    },
  };
}

export async function flushStartup(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}
