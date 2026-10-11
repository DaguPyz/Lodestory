import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { uiPluginFixture } from "./helpers/uiPluginFixture.mjs";

function contributor(f, id, activate, deactivate = () => {}) {
  return f.core.mount({
    id,
    requires: [f.uiKey],
    provides: [],
    activate,
    deactivate,
  });
}

test("UI plugin types connect PluginContext, uiKey, root views, and wrappers", () => {
  const fixture = fileURLToPath(new URL("./fixtures/ui-plugin-types.tsx", import.meta.url));
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")).join("\n"),
    "",
  );
});

test("activation registers uiKey but waits for pluginsReady and mounts only once", async () => {
  const container = {};
  const rootOptions = { identifierPrefix: "lodestory-" };
  const f = uiPluginFixture({ container, rootOptions });
  const { plugin, service } = await f.mountUi();

  assert.equal(f.core.get(f.uiKey), service);
  assert.equal(plugin.id, "ui");
  assert.equal(plugin.requires.length, 0);
  assert.equal(plugin.provides.length, 1);
  assert.equal(plugin.provides[0], f.uiKey);
  assert.equal(f.roots.length, 0, "activation must not call createRoot");

  await contributor(f, "app-root", (context) => {
    context.get(f.uiKey).setRoot(() => f.React.createElement("main", { children: "Lodestory" }));
  });
  assert.equal(f.roots.length, 0, "the root is still deferred until ready");

  await f.notifyReady();
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].container, container);
  assert.equal(f.roots[0].options, rootOptions);
  assert.equal(f.roots[0].renderCalls.length, 1);
  assert.equal(f.roots[0].renderCalls[0].type, f.React.StrictMode);

  await f.notifyReady();
  assert.equal(f.roots.length, 1, "a repeated ready event must not create another root");
  assert.equal(f.roots[0].renderCalls.length, 1, "a repeated ready event must not render again");

  await f.core.unmount("app-root");
  await f.core.unmount("ui");
});

test("UI registration rejects missing, duplicate, and invalid contributions", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi();

  assert.throws(() => service.setRoot(undefined), /render function/);
  const disposeRoot = service.setRoot(() => f.React.createElement("main"));
  assert.throws(() => service.setRoot(() => f.React.createElement("aside")), /root is already registered/);

  assert.throws(() => service.addWrapper({ id: "  ", order: 1, wrap: (children) => children }), /id cannot be empty/);
  assert.throws(() => service.addWrapper({ id: "nan", order: Number.NaN, wrap: (children) => children }), /order must be finite/);
  assert.throws(() => service.addWrapper({ id: "infinite", order: Infinity, wrap: (children) => children }), /order must be finite/);
  const disposeWrapper = service.addWrapper({ id: "unique", order: 1, wrap: (children) => children });
  assert.throws(() => service.addWrapper({ id: "unique", order: 2, wrap: (children) => children }), /already registered/);

  disposeRoot();
  disposeRoot();
  disposeWrapper();
  await f.core.unmount("ui");
});

test("ready without a root fails, then closes registration for this startup", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi();

  await assert.rejects(f.notifyReady(), (error) => {
    assert.match(error.message, /runtime\/plugins-ready/);
    assert.equal(error.listenerErrors[0].pluginId, "ui");
    assert.match(error.listenerErrors[0].error.message, /UI root is not registered/);
    return true;
  });
  assert.equal(f.roots.length, 0);
  assert.throws(() => service.setRoot(() => f.React.createElement("main")), /before pluginsReady/);
  assert.throws(() => service.addWrapper({ id: "late", order: 1, wrap: (children) => children }), /before pluginsReady/);
  await f.notifyReady();
  assert.equal(f.roots.length, 0, "a failed ready notification is not retried in the same activation");

  await f.core.unmount("ui");
});

test("wrappers are snapshotted, sorted outside-in, and pass ThemeService through ThemeProvider", async () => {
  const f = uiPluginFixture();
  const { service: ui } = await f.mountUi();
  const { ThemeProvider, useThemeService } = f.loadSource("theme/ThemeProvider.tsx");
  const themeService = {
    getSnapshot: () => ({ mode: "dark", resolvedTheme: "dark", persistenceError: false, windowError: false }),
    subscribe: () => () => {},
    setMode() {},
    retry() {},
  };
  const calls = [];
  const makeWrapper = (id, order) => ({
    id,
    order,
    wrap(children) {
      calls.push(id);
      return f.React.createElement("div", { "data-ui-wrapper": id, children });
    },
  });
  const first = makeWrapper("first", 10);
  const disposeFirst = ui.addWrapper(first);
  ui.addWrapper(makeWrapper("second", 10));
  const themeWrapper = {
    id: "theme-provider",
    order: 20,
    wrap(children) {
      calls.push("theme-provider");
      return f.React.createElement(ThemeProvider, { service: themeService, children });
    },
  };
  ui.addWrapper(themeWrapper);
  ui.addWrapper(makeWrapper("last", 30));

  // Mutating the caller's descriptor after registration must not change its saved order or function.
  first.id = "changed-id";
  first.order = 100;
  first.wrap = () => { throw new Error("mutated wrapper must not run"); };
  themeWrapper.order = 0;
  themeWrapper.wrap = () => { throw new Error("mutated theme wrapper must not run"); };

  function App() {
    const sameService = useThemeService() === themeService;
    return f.React.createElement("span", { "data-same-service": String(sameService), children: "ready" });
  }
  await contributor(f, "app-root", (context) => {
    context.get(f.uiKey).setRoot(() => f.React.createElement(App));
  });
  await f.notifyReady();

  assert.deepEqual(calls, ["last", "theme-provider", "second", "first"], "reduceRight invokes wrappers inside-out");
  const strictTree = f.roots[0].renderCalls[0];
  assert.equal(strictTree.type, f.React.StrictMode);
  let node = strictTree.props.children;
  const outsideIn = [];
  while (node?.props?.["data-ui-wrapper"]) {
    outsideIn.push(node.props["data-ui-wrapper"]);
    node = node.props.children;
  }
  assert.deepEqual(outsideIn, ["first", "second"]);
  assert.equal(node.type, ThemeProvider);
  node = node.props.children;
  assert.equal(node.props["data-ui-wrapper"], "last");
  node = node.props.children;
  assert.equal(node.type, App);

  const markup = f.renderToStaticMarkup(strictTree);
  assert.match(markup, /data-same-service="true"/, "ThemeProvider exposes the exact service supplied by its plugin");
  assert.match(markup, />ready<\/span>/);

  // Disposing a contribution after render first unmounts the whole tree; repeated disposal is harmless.
  disposeFirst();
  disposeFirst();
  assert.equal(f.roots[0].unmountCalls, 1);

  await f.core.unmount("app-root");
  await f.core.unmount("ui");
});

test("disposing a contribution before ready removes it from the assembled tree", async () => {
  const f = uiPluginFixture();
  const { service: ui } = await f.mountUi();
  let invoked = false;
  const dispose = ui.addWrapper({
    id: "rolled-back",
    order: 1,
    wrap(children) { invoked = true; return children; },
  });
  dispose();
  dispose();
  ui.setRoot(() => f.React.createElement("main"));
  await f.notifyReady();

  assert.equal(invoked, false);
  assert.equal(f.roots.length, 1);
  await f.core.unmount("ui");
});

test("deactivation revokes an old UiService and old disposers cannot affect a new activation", async () => {
  const f = uiPluginFixture();
  const plugin = f.createUiPlugin(f.container);
  await f.core.mount(plugin);
  const oldUi = f.core.get(f.uiKey);
  const oldDispose = oldUi.setRoot(() => f.React.createElement("main", { children: "old" }));
  await f.notifyReady();
  await f.core.unmount("ui");
  assert.equal(f.roots[0].unmountCalls, 1);
  assert.throws(() => oldUi.addWrapper({ id: "old", order: 1, wrap: (children) => children }), /no longer active/);

  await f.core.mount(plugin);
  const newUi = f.core.get(f.uiKey);
  assert.notEqual(newUi, oldUi);
  oldDispose();
  newUi.setRoot(() => f.React.createElement("main", { children: "new" }));
  await f.notifyReady();
  assert.equal(f.roots.length, 2);
  assert.equal(f.roots[1].renderCalls.length, 1);
  await f.core.unmount("ui");
});

test("a synchronous render failure propagates and plugin shutdown unmounts the retained React root", async () => {
  const f = uiPluginFixture({ renderError: new Error("render failed") });
  const { service: ui } = await f.mountUi();
  ui.setRoot(() => f.React.createElement("main"));

  await assert.rejects(f.notifyReady(), /runtime\/plugins-ready/);
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].renderCalls.length, 1);
  assert.equal(f.roots[0].unmountCalls, 0);

  f.controls.renderError = null;
  await f.core.unmount("ui");
  assert.equal(f.roots[0].unmountCalls, 1);
  assert.throws(() => ui.setRoot(() => f.React.createElement("aside")), /no longer active/);

});
