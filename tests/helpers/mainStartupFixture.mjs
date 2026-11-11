import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { createSdkLoader } from "./sdkFixture.mjs";
import { resolveUiPackageImport } from "./uiPackageFixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

export function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

export function createMainFixture({ tauri = true, nativeSetGate = null, nativeSetError = false, missingRoot = false, themeDefinitions = [], omitBuiltinThemes = false, omitNavigationLayout = false, omitWindowShell = false, preference, configBaseValues, configOverrides, configStorageReadError, configStorageWriteError, layoutFactory, navigationLayoutFactory, windowShellFactory, additionalPlugins = [], invokeHandler, moduleMocks = {}, mockWorkbenchToolbar = true, sameRealm = false } = {}) {
  const modules = new Map();
  const sdk = createSdkLoader({ modules });
  const createdCores = [];
  const rootCalls = [];
  const moduleImports = [];
  const catalogPluginIds = [];
  const bodyEditorModels = new Map();
  const bodyEditorResolvers = new Map();
  const bodyEditorConversionResolvers = new Map();
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
  rootElement.hasChildNodes = () => rootElement.children.length > 0 || roots.some(root => root.mounted);
  const body = {
    children: [],
    append(child) { child.parent = this; this.children.push(child); },
  };
  const documentRootAttributes = new Map();
  const documentRoot = {
    dataset: {},
    getAttribute(name) { return documentRootAttributes.has(name) ? documentRootAttributes.get(name) : null; },
    setAttribute(name, value) {
      documentRootAttributes.set(name, String(value));
      if (name === "data-ui-motion") this.dataset.uiMotion = String(value);
    },
    removeAttribute(name) {
      documentRootAttributes.delete(name);
      if (name === "data-ui-motion") delete this.dataset.uiMotion;
    },
    style: {
      setProperty(name, value) { if (name === "--ui-surface-workspace") themeApplications.push({ id: documentRoot.dataset.uiThemeId, value }); },
      removeProperty() {},
    },
  };
  const document = {
    documentElement: documentRoot,
    body,
    getElementById(id) { return id === "root" && !missingRoot ? rootElement : null; },
    createElement(tagName) {
      return {
        tagName,
        textContent: "",
        type: "",
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { for (const child of children) child.parent = this; this.children = [...(this.children ?? []), ...children]; },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; },
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
    async destroy() { logs.push("window.destroy"); if (faults.destroyError) throw faults.destroyError; },
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
    useLayoutEffect() {},
    useState(initialValue) {
      let value = typeof initialValue === "function" ? initialValue() : initialValue;
      return [value, next => { value = typeof next === "function" ? next(value) : next; }];
    },
    useRef(initialValue) { return {current: initialValue}; },
    useMemo(factory) { return factory(); },
    useCallback(callback) { return callback; },
    memo(component) { return component; },
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
          this.mounted = true;
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
          this.mounted = false;
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
    DocumentTabs: function DocumentTabs() {},
    NavigationLayout: function NavigationLayout({ pageId, active, items, onNavigate, children }) {
      return React.createElement("navigation-layout", { pageId, active, items, onNavigate, children });
    },
    EditorPage: function EditorPage() {},
    BodyEditorContentProvider: function BodyEditorContentProvider({ workbench, models, resolveEditor, resolveConversions, children }) {
      const session = workbench.getSnapshot().session;
      if (session) {
        bodyEditorModels.set(session.id, models.get(session.id));
        if (resolveEditor) bodyEditorResolvers.set(session.id, resolveEditor);
        if (resolveConversions) bodyEditorConversionResolvers.set(session.id, resolveConversions);
      }
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
    ThemeSettings: function ThemeSettings() {},
    PageShell: function PageShell() {},
    ContextMenuProvider: function ContextMenuProvider() {},
    ThemeProvider: function ThemeProvider() {},
  };
  let UiPages;
  let activationError;
  let cleanupError;
  let omitThemeService = false;
  let omitNavigationLayoutPlugin = omitNavigationLayout;
  let omitWindowShellPlugin = omitWindowShell;

  function resolveLocal(fromPath, specifier) {
    if (!specifier.startsWith(".")) throw new Error(`Unexpected local import '${specifier}' from ${fromPath}`);
    const base = resolve(dirname(fromPath), specifier);
    const candidates = [base, `${base}.tsx`, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.css`,
      resolve(base, "index.tsx"), resolve(base, "index.ts")];
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
    if (Object.hasOwn(moduleMocks, relativePath)) return {...moduleMocks[relativePath], __esModule: true};
    if (relativePath === "plugins/welcome/WelcomePage.tsx") return { __esModule: true, WelcomePage: components.WelcomePage };
    if (relativePath === "plugins/navigation-layout/NavigationLayout.tsx") return { __esModule: true, NavigationLayout: components.NavigationLayout };
    if (relativePath === "plugins/document-tabs/DocumentTabs.tsx") return { __esModule: true, DocumentTabs: components.DocumentTabs };
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
    if (relativePath === "plugins/settings/ThemeSettings.tsx") return { __esModule: true, ThemeSettings: components.ThemeSettings };
    if (relativePath === "components/PageShell.tsx") return { __esModule: true, PageShell: components.PageShell };
    if (relativePath === "plugins/context-menu/ContextMenuProvider.tsx") {
      return {
        __esModule: true,
        ContextMenuProvider: components.ContextMenuProvider,
        useContextMenus() { return {activate() {}, release() {}}; },
      };
    }
    if (relativePath === "plugins/context-menu/ContextMenuRegion.tsx") return {
      ContextMenuRegion: function ContextMenuRegion({children}) { return children; },
    };
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
      // TypeScript preserves ESM syntax for .mjs even when CommonJS is requested.
      // The fixture executes all local modules in a CommonJS VM.
      fileName: path.endsWith(".mjs") ? `${path.slice(0, -4)}.js` : path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    const globals = {
      exports,
      console: {
        error(...args) { logs.push({ level: "error", args }); },
        warn(...args) { logs.push({ level: "warn", args }); },
      },
      document,
      window,
      BroadcastChannel: Channel,
      AbortController,
      setTimeout,
      clearTimeout,
      Promise,
      Error,
      Symbol,
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      Map,
      Set,
      Object,
      Array,
      require(specifier) {
        moduleImports.push({ from: relativePath, specifier });
        if (Object.hasOwn(moduleMocks, specifier)) return moduleMocks[specifier];
        const uiImport = resolveUiPackageImport(specifier, load);
        if (uiImport.handled) return uiImport.value;
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relativePath);
        if (specifier === "react") return React;
        if (specifier === "react-dom/client") return ReactDOM;
        if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
          return {
            jsx(type, props, key) { return { type, props: props ?? {}, key }; },
            jsxs(type, props, key) { return { type, props: props ?? {}, key }; },
            Fragment: Symbol("Fragment"),
          };
        }
        if (specifier === "@tauri-apps/api/core") return {
          isTauri: () => tauri,
          async invoke(command, args, options) {
            tauriCalls.push({ command, args, ...(options === undefined ? {} : {options}) });
            if (command === "run_background_task") {
              if (args.name !== "asset-management/validate-and-encode-group") throw new Error("Unknown background task");
              return new TextEncoder().encode(`${JSON.stringify(args.input.data, null, 2)}\n`).buffer;
            }
            if (invokeHandler) return invokeHandler(command, args, options);
            if (command === "list_project_directory") return {exists: false, entries: [], issues: []};
            if (command === "list_documents") return [];
            if (command === "create_project_file") return {path: args.path, fileName: args.path.split("/").at(-1), bytes: args.bytes};
            if (command === "read_project_file") return {path: args.path, fileName: args.path.split("/").at(-1), bytes: []};
            if (command === "read_project_file_base64") return {path: args.path, fileName: args.path.split("/").at(-1), bytesBase64: "", byteLength: 0};
            if (command === "create_project_file_base64") return {path: args.path, fileName: args.path.split("/").at(-1), bytesBase64: args.bytesBase64,
              byteLength: Buffer.from(args.bytesBase64, "base64").length};
            if (command === "save_project_file_binary" || command === "save_project_file_base64" || command === "delete_project_file_base64") return undefined;
            if (command === "save_project_file" || command === "delete_project_file" || command === "create_project_directory") return undefined;
            throw new Error(`Unexpected Tauri command '${command}'.`);
          },
        };
        if (specifier === "react-dom") return ReactDOM;
        if (specifier === "@tauri-apps/api/window") return { getCurrentWindow: () => appWindow };
        return load(resolveLocal(path, specifier));
      },
    };
    // Some modules validate plain-object prototypes or return objects to the test.
    // Run those modules in the test's realm so literals, JSON, and injected values agree.
    if (sameRealm) vm.compileFunction(compiled, Object.keys(globals), {filename: path})(...Object.values(globals));
    else vm.runInNewContext(compiled, globals, {filename: path});

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
    if (relativePath === "plugins/window-shell/PageShell.tsx") {
      components.PageShell = exports.PageShell;
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
        const plugins = createAppPlugins(...args).filter(plugin =>
          (!omitBuiltinThemes || plugin.id !== "builtin-themes")
          && (!omitNavigationLayoutPlugin || plugin.id !== "navigation-layout")
          && (!omitWindowShellPlugin || plugin.id !== "window-shell"))
          .map(plugin => {
            if (plugin.id === "default-layout" && layoutFactory) return layoutFactory(sdk.requireSdk("@lodestory/sdk/layout"));
            if (plugin.id === "navigation-layout" && navigationLayoutFactory) return navigationLayoutFactory(sdk);
            if (plugin.id === "window-shell" && windowShellFactory) return windowShellFactory(sdk);
            return plugin;
          });
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
    body,
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
    omitNavigationLayout() { omitNavigationLayoutPlugin = true; },
    omitWindowShell() { omitWindowShellPlugin = true; },
    getService(key) { return createdCores.at(-1)?.get(key); },
    bodyEditorModels,
    bodyEditorResolvers,
    bodyEditorConversionResolvers,
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
