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

function createDocumentRoot() {
  const attributes = new Map();
  return {
    id: "root",
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function findModule(fromPath, specifier) {
  const base = resolve(dirname(fromPath), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  const path = candidates.find((candidate) => {
    try {
      readFileSync(candidate, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (!path) throw new Error(`Cannot resolve ${specifier} from ${fromPath}`);
  return path;
}

/**
 * Load the real plugin core and UI plugin sources into an isolated CommonJS
 * graph, while retaining real React elements and replacing only createRoot.
 */
export function uiPluginFixture({ container = {}, documentRoot = createDocumentRoot(), rootOptions, renderError = null, renderErrorOnce = null } = {}) {
  const modules = new Map();
  const sdk = createSdkLoader({ modules });
  const roots = [];
  const logs = [];
  const flushSyncEvents = [];
  const documentLookups = [];
  const document = {
    documentElement: documentRoot,
    getElementById(id) {
      documentLookups.push(id);
      return id === "root" ? documentRoot : null;
    },
  };
  const window = { location: { reloadCalls: 0, reload() { this.reloadCalls += 1; } } };
  const controls = { renderError, renderErrorOnce, uncaughtErrorDuringRender: null, createRootError: null, unmountError: null };
  let hookRuntime;
  const ReactWithHooks = {
    ...React,
    useState(initialValue) {
      if (!hookRuntime) return React.useState(initialValue);
      const { hooks, index } = hookRuntime;
      hookRuntime.index += 1;
      if (!(index in hooks)) hooks[index] = { value: typeof initialValue === "function" ? initialValue() : initialValue };
      const hook = hooks[index];
      return [hook.value, (nextValue) => {
        hook.value = typeof nextValue === "function" ? nextValue(hook.value) : nextValue;
      }];
    },
    useRef(initialValue) {
      if (!hookRuntime) return React.useRef(initialValue);
      const { hooks, index } = hookRuntime;
      hookRuntime.index += 1;
      if (!(index in hooks)) hooks[index] = { value: { current: initialValue } };
      return hooks[index].value;
    },
    useCallback(callback, dependencies) {
      if (!hookRuntime) return React.useCallback(callback, dependencies);
      const { hooks, index } = hookRuntime;
      hookRuntime.index += 1;
      const previous = hooks[index];
      const changed = !previous || !dependencies || !previous.dependencies
        || dependencies.length !== previous.dependencies.length
        || dependencies.some((value, dependencyIndex) => !Object.is(value, previous.dependencies[dependencyIndex]));
      if (changed) hooks[index] = { value: callback, dependencies };
      return hooks[index].value;
    },
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      if (hookRuntime) {
        hookRuntime.index += 1;
        return getSnapshot();
      }
      return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    },
  };
  const reactDomClient = {
    createRoot(target, options) {
      if (controls.createRootError) throw controls.createRootError;
      const record = { container: target, options, renderCalls: [], unmountCalls: 0 };
      const root = {
        render(node) {
          record.renderCalls.push(node);
          if (controls.uncaughtErrorDuringRender) {
            options?.onUncaughtError?.(controls.uncaughtErrorDuringRender, { componentStack: "" });
            controls.uncaughtErrorDuringRender = null;
          }
          if (controls.renderErrorOnce) {
            const error = controls.renderErrorOnce;
            controls.renderErrorOnce = null;
            throw error;
          }
          if (controls.renderError) throw controls.renderError;
        },
        unmount() {
          record.unmountCalls += 1;
          if (controls.unmountError) throw controls.unmountError;
        },
      };
      record.root = root;
      roots.push(record);
      return root;
    },
  };

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
      console: { error(...args) { logs.push(args); } },
      document,
      window,
      require(specifier) {
        const uiImport = resolveUiPackageImport(specifier, load);
        if (uiImport.handled) return uiImport.value;
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relative(sourceRoot, path));
        if (specifier === "react") return ReactWithHooks;
        if (specifier === "react/jsx-runtime") return jsxRuntime;
        if (specifier === "react/jsx-dev-runtime") return jsxDevRuntime;
        if (specifier === "react-dom") return { flushSync(callback) {
          flushSyncEvents.push("start");
          try { callback(); }
          finally { flushSyncEvents.push("end"); }
        } };
        if (specifier === "react-dom/client") return reactDomClient;
        return load(findModule(path, specifier));
      },
    }, { filename: path });
    return exports;
  }

  const eventBusModule = load(resolve(sourceRoot, "plugin-core/EventBus.ts"));
  const BaseEventBus = eventBusModule.EventBus;
  let eventBus;
  eventBusModule.EventBus = class TrackedEventBus extends BaseEventBus {
    constructor(...args) {
      super(...args);
      eventBus = this;
    }
  };
  const { EngineCore } = load(resolve(sourceRoot, "plugin-core/EngineCore.ts"));
  const { pluginsReady } = load(resolve(sourceRoot, "plugin-core/runtimeEvents.ts"));
  const { createErrorUiPlugin } = load(resolve(sourceRoot, "plugins/error-ui/errorUiPlugin.tsx"));
  const { createUiPlugin } = load(resolve(sourceRoot, "plugins/ui/uiPlugin.tsx"));
  const { uiKey } = sdk.requireSdk("@lodestory/sdk/ui");
  const { uiInitialPageConfig } = sdk.requireSdk("@lodestory/sdk/ui");
  const { uiMotionConfig } = sdk.requireSdk("@lodestory/sdk/ui");
  const { configKey } = sdk.requireSdk("@lodestory/sdk/config");
  const { errorUiKey } = sdk.requireSdk("@lodestory/sdk/error");
  const core = new EngineCore();

  const configFaults = { readError: null, writeError: null };
  const configItems = new Map();
  const configValues = new Map();
  const configListeners = new Map();
  const configService = {
    register(item) {
      if (configItems.has(item.id)) throw new Error(`Configuration '${item.id}' is already registered.`);
      if (!item.validate(item.defaultValue)) throw new TypeError(`Configuration '${item.id}' has an invalid default value.`);
      configItems.set(item.id, item);
      return () => {
        if (configItems.get(item.id) === item) configItems.delete(item.id);
      };
    },
    getSnapshot(item) {
      if (configFaults.readError) throw configFaults.readError;
      if (configItems.get(item.id) !== item) throw new Error(`Configuration '${item.id}' is not registered.`);
      return configValues.has(item.id) ? configValues.get(item.id) : item.defaultValue;
    },
    async set(item, value) {
      if (configItems.get(item.id) !== item) throw new Error(`Configuration '${item.id}' is not registered.`);
      if (!item.validate(value)) throw new TypeError(`Configuration '${item.id}' has an invalid value.`);
      if (configFaults.writeError) throw configFaults.writeError;
      configValues.set(item.id, value);
      for (const listener of [...(configListeners.get(item.id) ?? [])]) listener();
    },
    async reset(item) {
      if (configItems.get(item.id) !== item) throw new Error(`Configuration '${item.id}' is not registered.`);
      configValues.delete(item.id);
      for (const listener of [...(configListeners.get(item.id) ?? [])]) listener();
    },
    subscribe(item, listener) {
      if (configItems.get(item.id) !== item) throw new Error(`Configuration '${item.id}' is not registered.`);
      let listeners = configListeners.get(item.id);
      if (!listeners) configListeners.set(item.id, listeners = new Set());
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const createConfigPlugin = () => ({
    id: "test-config",
    requires: [],
    provides: [configKey],
    activate(context) { context.provide(configKey, configService); },
  });

  return {
    React: ReactWithHooks,
    core,
    container,
    controls,
    createUiPlugin,
    createConfigPlugin,
    createErrorUiPlugin,
    config: configService,
    configFaults,
    configKey,
    document,
    documentLookups,
    documentRoot,
    pluginsReady,
    roots,
    logs,
    uiKey,
    uiInitialPageConfig,
    uiMotionConfig,
    errorUiKey,
    flushSyncEvents,
    window,
    requireSdk(specifier) { return sdk.requireSdk(specifier); },
    sdkImports: sdk.imports,
    sdkEvaluatedModules: sdk.evaluatedModules,
    rootOptions,
    async mountUi(options = (rootOptions ? { rootOptions } : {})) {
      await core.mount(createConfigPlugin());
      const errorPlugin = createErrorUiPlugin();
      await core.mount(errorPlugin);
      const plugin = createUiPlugin(container, options);
      await core.mount(plugin);
      return { plugin, service: core.get(uiKey), errorService: core.get(errorUiKey) };
    },
    withHooks(instance, render) {
      hookRuntime = { hooks: instance.hooks ?? (instance.hooks = []), index: 0 };
      try { return render(); }
      finally { hookRuntime = undefined; }
    },
    notifyReady(payload = undefined) {
      if (!eventBus) throw new Error("The EngineCore has not been created yet.");
      return eventBus.emit(pluginsReady, payload);
    },
    loadSource(relativePath) {
      return load(resolve(sourceRoot, relativePath));
    },
    renderToStaticMarkup(element) {
      return requireFromHere("react-dom/server").renderToStaticMarkup(element);
    },
  };
}
