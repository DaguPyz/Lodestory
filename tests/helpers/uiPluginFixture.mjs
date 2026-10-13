import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createSdkLoader } from "./sdkFixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const React = requireFromHere("react");
const jsxRuntime = requireFromHere("react/jsx-runtime");
const jsxDevRuntime = requireFromHere("react/jsx-dev-runtime");

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
export function uiPluginFixture({ container = {}, rootOptions, renderError = null, renderErrorOnce = null } = {}) {
  const modules = new Map();
  const sdk = createSdkLoader({ modules });
  const roots = [];
  const logs = [];
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
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      if (hookRuntime) return getSnapshot();
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
      window,
      require(specifier) {
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relative(sourceRoot, path));
        if (specifier === "react") return ReactWithHooks;
        if (specifier === "react/jsx-runtime") return jsxRuntime;
        if (specifier === "react/jsx-dev-runtime") return jsxDevRuntime;
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
  const { createUiPlugin } = load(resolve(sourceRoot, "plugins/ui/uiPlugin.tsx"));
  const { uiKey } = sdk.requireSdk("@lodestory/sdk/ui");
  const core = new EngineCore();

  return {
    React: ReactWithHooks,
    core,
    container,
    controls,
    createUiPlugin,
    pluginsReady,
    roots,
    logs,
    uiKey,
    window,
    requireSdk(specifier) { return sdk.requireSdk(specifier); },
    sdkImports: sdk.imports,
    sdkEvaluatedModules: sdk.evaluatedModules,
    rootOptions,
    async mountUi(options = (rootOptions ? { rootOptions } : {})) {
      const plugin = createUiPlugin(container, options);
      await core.mount(plugin);
      return { plugin, service: core.get(uiKey) };
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
