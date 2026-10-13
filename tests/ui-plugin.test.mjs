import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { uiPluginFixture } from "./helpers/uiPluginFixture.mjs";

function contributor(f, id, activate, deactivate = () => {}) {
  return f.core.mount({ id, requires: [f.uiKey], provides: [], activate, deactivate });
}

function page(id, render = () => null) {
  return { id, render };
}

async function flushUiMicrotasks() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function renderedErrorPage(f, root) {
  const { UiErrorPage } = f.loadSource("plugins/ui/UiErrorPage.tsx");
  const node = root.renderCalls.at(-1);
  assert.equal(node.type, UiErrorPage);
  return node.type(node.props);
}

function startupError(errorPattern) {
  return (error) => {
    assert.match(error.message, /runtime\/plugins-ready/);
    assert.match(error.listenerErrors[0].error.message, errorPattern);
    return true;
  };
}

function renderVisitedPages(f, service, instances) {
  const { UiPages } = f.loadSource("plugins/ui/UiPages.tsx");
  const tree = f.withHooks({}, () => UiPages({ service }));
  const pageNodes = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
  return Array.from(pageNodes, (pageNode) => {
    const id = pageNode.key;
    const component = pageNode.props.children;
    let instance = instances.get(id);
    if (!instance) {
      instance = {};
      instances.set(id, instance);
    }
    const output = f.withHooks(instance, () => component.type(component.props));
    return { id, hidden: pageNode.props.hidden, output };
  });
}

test("UI plugin types connect PluginContext, pages, navigation, and wrappers", () => {
  const fixture = fileURLToPath(new URL("./fixtures/ui-plugin-types.tsx", import.meta.url));
  const browserFixture = fileURLToPath(new URL("./fixtures/ui-pages.tsx", import.meta.url));
  const viteTypes = fileURLToPath(new URL("../src/vite-env.d.ts", import.meta.url));
  const program = ts.createProgram([fixture, browserFixture, viteTypes], {
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

test("activation waits for ready, mounts one page container, and allows navigation afterward", async () => {
  const container = {};
  const onCaughtError = () => {};
  const onRecoverableError = () => {};
  const rootOptions = { identifierPrefix: "lodestory-", onCaughtError, onRecoverableError };
  const f = uiPluginFixture({ container, rootOptions });
  const { plugin, service } = await f.mountUi({ initialPage: "home", rootOptions });

  assert.deepEqual(f.documentLookups, [], "an explicit container avoids document lookup");
  assert.equal(f.core.get(f.uiKey), service);
  assert.equal(plugin.id, "ui");
  assert.equal(plugin.requires.length, 0);
  assert.equal(plugin.provides.length, 1);
  assert.equal(plugin.provides[0], f.uiKey);
  assert.equal(f.roots.length, 0, "activation must not call createRoot");
  assert.throws(() => service.openPage("home"), /navigation requires .*after pluginsReady/);

  await contributor(f, "home", (context) => {
    context.get(f.uiKey).registerPage({
      id: "home",
      render: ({ params, active }) => f.React.createElement("main", {
        "data-page": "home",
        "data-active": String(active),
        children: params === undefined ? "Lodestory" : String(params),
      }),
    });
  });
  assert.equal(f.roots.length, 0, "the root is deferred until ready");

  await f.notifyReady();
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].container, f.container);
  assert.deepEqual(f.documentLookups, [], "an explicit container remains the createRoot target");
  assert.notEqual(f.roots[0].options, rootOptions, "UI installs its own uncaught error handler");
  assert.equal(f.roots[0].options.identifierPrefix, rootOptions.identifierPrefix);
  assert.equal(f.roots[0].options.onCaughtError, onCaughtError);
  assert.equal(f.roots[0].options.onRecoverableError, onRecoverableError);
  assert.equal(typeof f.roots[0].options.onUncaughtError, "function");
  assert.equal(f.roots[0].renderCalls.length, 1);
  assert.equal(f.roots[0].renderCalls[0].type, f.React.StrictMode);
  assert.equal(service.getSnapshot().current.id, "home");
  assert.match(f.renderToStaticMarkup(f.roots[0].renderCalls[0]), /data-page="home"/);

  service.openPage("home", { from: "ready" });
  assert.equal(service.getSnapshot().current.params.from, "ready");
  assert.equal(f.roots.length, 1, "navigation updates the mounted root instead of creating another one");
  assert.equal(f.roots[0].renderCalls.length, 1, "navigation is handled by the mounted page container");

  await f.notifyReady();
  assert.equal(f.roots.length, 1, "a repeated ready event must not create another root");
  assert.equal(f.roots[0].renderCalls.length, 1, "a repeated ready event must not render again");

  await f.core.unmount("home");
  await f.core.unmount("ui");
});

test("a no-argument UI plugin resolves #root at ready and defaults to the first registered page", async () => {
  const f = uiPluginFixture();
  const plugin = f.createUiPlugin();

  assert.deepEqual(f.documentLookups, [], "factory creation must not inspect the document");
  await f.core.mount(plugin);
  const service = f.core.get(f.uiKey);
  service.registerPage(page("first"));
  service.registerPage(page("second"));
  assert.deepEqual(f.documentLookups, [], "activation only registers the UI service");

  await f.notifyReady();

  assert.deepEqual(f.documentLookups, ["root"]);
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].container, f.documentRoot);
  assert.equal(service.getSnapshot().current.id, "first");
  assert.deepEqual(Array.from(service.getSnapshot().pages, ({ id }) => id), ["first"]);
  await f.core.unmount("ui");
});

test("a missing default #root fails EngineCore startup before createRoot and rolls UI back", async () => {
  const f = uiPluginFixture({ documentRoot: null });
  const pagePlugin = {
    id: "page-contributor",
    requires: [f.uiKey],
    provides: [],
    activate(context) {
      context.get(f.uiKey).registerPage(page("home"));
    },
  };

  await assert.rejects(
    f.core.start([f.createUiPlugin(), pagePlugin]),
    startupError(/UI root container '#root' was not found/),
  );

  assert.deepEqual(f.documentLookups, ["root"]);
  assert.equal(f.roots.length, 0);
  assert.equal(f.core.isMounted("ui"), false);
  assert.equal(f.core.isMounted("page-contributor"), false);
});

test("page registration validates descriptors and wrappers remain unique", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi();

  assert.throws(() => service.registerPage(undefined), /UI page must be an object/);
  assert.throws(() => service.registerPage({ id: "  ", render() {} }), /page id cannot be empty/);
  assert.throws(() => service.registerPage({ id: "missing-render" }), /render must be a function/);
  const disposePage = service.registerPage(page("unique"));
  assert.throws(() => service.registerPage(page("unique")), /already registered/);

  assert.throws(() => service.addWrapper({ id: "  ", order: 1, wrap: (children) => children }), /id cannot be empty/);
  assert.throws(() => service.addWrapper({ id: "nan", order: Number.NaN, wrap: (children) => children }), /order must be finite/);
  assert.throws(() => service.addWrapper({ id: "infinite", order: Infinity, wrap: (children) => children }), /order must be finite/);
  const disposeWrapper = service.addWrapper({ id: "unique", order: 1, wrap: (children) => children });
  assert.throws(() => service.addWrapper({ id: "unique", order: 2, wrap: (children) => children }), /already registered/);

  disposePage();
  disposePage();
  disposeWrapper();
  await f.core.unmount("ui");
});

test("ready fails without a page and closes startup registration", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi();

  await assert.rejects(f.notifyReady(), startupError(/without registered pages/));
  assert.equal(f.roots.length, 0);
  assert.throws(() => service.registerPage(page("late")), /before pluginsReady/);
  assert.throws(() => service.openPage("late"), /navigation requires .*after pluginsReady/);
  await f.notifyReady();
  assert.equal(f.roots.length, 0, "a failed ready notification is not retried in the same activation");

  await f.core.unmount("ui");
});

test("ready rejects an unknown initial page without creating a React root", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi({ initialPage: "missing" });
  service.registerPage(page("home"));

  await assert.rejects(f.notifyReady(), startupError(/page 'missing' is not registered/));
  assert.equal(f.roots.length, 0);
  await f.core.unmount("ui");
});

test("visited A/B/C pages receive params, hide inactive views, and back restores the previous location", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi({ initialPage: "A" });
  let bInitializations = 0;
  let updateBDraft;
  const PageA = ({ params, active }) => f.React.createElement("section", {
    "data-page": "A", "data-active": String(active), children: `A:${params?.value ?? "initial"}`,
  });
  const PageB = ({ params, active }) => {
    const [draft, setDraft] = f.React.useState(() => {
      bInitializations += 1;
      return "initial draft";
    });
    updateBDraft = setDraft;
    return f.React.createElement("section", {
      "data-page": "B",
      "data-active": String(active),
      "data-project": params?.value,
      children: draft,
    });
  };
  const PageC = ({ params, active }) => f.React.createElement("section", {
    "data-page": "C", "data-active": String(active), children: `C:${params?.value ?? "initial"}`,
  });
  const pages = [
    page("A", (props) => f.React.createElement(PageA, props)),
    page("B", (props) => f.React.createElement(PageB, props)),
    page("C", (props) => f.React.createElement(PageC, props)),
  ];
  const disposers = pages.map((entry) => service.registerPage(entry));
  await f.notifyReady();

  const instances = new Map();
  let pageViews = renderVisitedPages(f, service, instances);
  assert.deepEqual(pageViews.map(({ id, hidden }) => [id, hidden]), [["A", false]]);
  assert.equal(service.getSnapshot().pages.length, 1);

  service.openPage("B", { value: "project-b" });
  assert.equal(service.getSnapshot().current.id, "B");
  assert.equal(service.getSnapshot().current.params.value, "project-b");
  pageViews = renderVisitedPages(f, service, instances);
  assert.deepEqual(pageViews.map(({ id, hidden }) => [id, hidden]), [["A", true], ["B", false]]);
  assert.equal(pageViews[1].output.props.children, "initial draft");
  assert.equal(bInitializations, 1);
  updateBDraft("edited draft");

  service.openPage("C", { value: "preview-c" });
  pageViews = renderVisitedPages(f, service, instances);
  assert.deepEqual(pageViews.map(({ id, hidden }) => [id, hidden]), [["A", true], ["B", true], ["C", false]]);
  assert.equal(pageViews[1].output.props.children, "edited draft");
  assert.equal(bInitializations, 1, "the page keyed by B keeps its hook state while hidden");
  assert.deepEqual(Array.from(service.getSnapshot().pages, ({ id, active }) => [id, active]), [
    ["A", false], ["B", false], ["C", true],
  ]);
  const html = f.renderToStaticMarkup(f.roots[0].renderCalls[0]);
  assert.match(html, /class="ui-page" hidden=""><section data-page="A"/);
  assert.match(html, /class="ui-page" hidden=""><section data-page="B"/);
  assert.match(html, /data-page="C" data-active="true">C:preview-c/);

  service.back();
  assert.equal(service.getSnapshot().current.id, "B");
  assert.equal(service.getSnapshot().current.params.value, "project-b");
  pageViews = renderVisitedPages(f, service, instances);
  assert.equal(pageViews.find(({ id }) => id === "B").hidden, false);
  assert.equal(pageViews.find(({ id }) => id === "B").output.props.children, "edited draft");
  service.back();
  assert.equal(service.getSnapshot().current.id, "A");
  assert.equal(service.getSnapshot().current.params, undefined);
  assert.equal(service.getSnapshot().canGoBack, false);
  pageViews = renderVisitedPages(f, service, instances);
  assert.equal(pageViews.find(({ id }) => id === "A").hidden, false);
  assert.equal(f.roots.length, 1, "A/B/C navigation must reuse one React root");
  assert.equal(f.roots[0].renderCalls.length, 1);

  for (const dispose of disposers) dispose();
  assert.equal(f.roots[0].unmountCalls, 1, "disposing a visited page first unmounts the whole tree");
  assert.throws(() => service.openPage("C"), /navigation requires .*after pluginsReady/);
  await f.core.unmount("ui");
});

test("wrappers surround the real UiPages tree and ThemeProvider receives its registered service", async () => {
  const f = uiPluginFixture();
  const { service: ui } = await f.mountUi({ initialPage: "home" });
  const { ThemeProvider, useThemeService } = f.loadSource("plugins/theme/ThemeProvider.tsx");
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
  ui.registerPage(page("home", () => f.React.createElement(Home)));

  // Mutating a caller descriptor after registration does not alter its saved rule.
  first.id = "changed-id";
  first.order = 100;
  first.wrap = () => { throw new Error("mutated wrapper must not run"); };
  themeWrapper.order = 0;
  themeWrapper.wrap = () => { throw new Error("mutated theme wrapper must not run"); };

  function Home() {
    const sameService = useThemeService() === themeService;
    return f.React.createElement("span", { "data-same-service": String(sameService), children: "ready" });
  }
  await f.notifyReady();

  assert.deepEqual(calls, ["last", "theme-provider", "second", "first"], "reduceRight invokes wrappers inside-out");
  const strictTree = f.roots[0].renderCalls[0];
  assert.equal(strictTree.type, f.React.StrictMode);
  const markup = f.renderToStaticMarkup(strictTree);
  assert.match(markup, /data-ui-wrapper="first"/);
  assert.match(markup, /data-ui-wrapper="second"/);
  assert.match(markup, /data-ui-wrapper="last"/);
  assert.match(markup, /data-same-service="true"/, "ThemeProvider exposes the exact service supplied by its plugin");
  assert.match(markup, />ready<\/span>/);

  disposeFirst();
  disposeFirst();
  assert.equal(f.roots[0].unmountCalls, 1, "removing a rendered contribution unmounts the tree first");
  await f.core.unmount("ui");
});

test("disposing an unvisited page before ready removes it from the initial snapshot", async () => {
  const f = uiPluginFixture();
  const { service } = await f.mountUi({ initialPage: "home" });
  let removedPageRendered = false;
  service.registerPage(page("home"));
  const dispose = service.registerPage(page("removed", () => {
    removedPageRendered = true;
    return null;
  }));
  dispose();
  dispose();
  await f.notifyReady();

  assert.equal(removedPageRendered, false);
  assert.deepEqual(Array.from(service.getSnapshot().pages, ({ id }) => id), ["home"]);
  await f.core.unmount("ui");
});

test("deactivation invalidates the previous service while a fresh activation gets a new registry", async () => {
  const f = uiPluginFixture();
  const plugin = f.createUiPlugin(f.container);
  await f.core.mount(plugin);
  const oldUi = f.core.get(f.uiKey);
  const oldDispose = oldUi.registerPage(page("old"));
  await f.notifyReady();
  await f.core.unmount("ui");
  assert.equal(f.roots[0].unmountCalls, 1);
  assert.throws(() => oldUi.openPage("old"), /no longer active/);

  await f.core.mount(plugin);
  const newUi = f.core.get(f.uiKey);
  assert.notEqual(newUi, oldUi);
  oldDispose();
  newUi.registerPage(page("new"));
  await f.notifyReady();
  assert.equal(f.roots.length, 2);
  assert.equal(newUi.getSnapshot().current.id, "new");
  await f.core.unmount("ui");
});

test("a synchronous initial render failure replaces the tree in the same root and leaves peer plugins active", async () => {
  const renderError = new Error("render failed");
  const f = uiPluginFixture({ renderErrorOnce: renderError });
  const { service: ui } = await f.mountUi();
  let peerDeactivated = false;
  await contributor(f, "page-contributor", (context) => {
    context.get(f.uiKey).registerPage(page("home"));
  }, () => { peerDeactivated = true; });

  await f.notifyReady();
  await flushUiMicrotasks();
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].renderCalls.length, 2);
  assert.equal(f.roots[0].unmountCalls, 0);
  assert.equal(f.core.isMounted("ui"), true);
  assert.equal(f.core.isMounted("page-contributor"), true);
  assert.equal(peerDeactivated, false);
  assert.equal(ui.getSnapshot().current.id, "home");
  assert.throws(() => ui.openPage("home"), /navigation requires .*after pluginsReady/);

  const fallback = renderedErrorPage(f, f.roots[0]);
  assert.equal(fallback.type, "main");
  assert.equal(fallback.props.className, "app-startup-error");
  assert.equal(fallback.props.role, "alert");
  const [heading, description, reload] = fallback.props.children;
  assert.equal(heading.props.children, "界面显示失败");
  assert.equal(description.props.children, "无法显示当前界面，请重新加载应用。");
  reload.props.onClick();
  assert.equal(f.window.location.reloadCalls, 1);
  assert.ok(f.logs.some(([message, detail]) => message === "UI rendering failed." && detail.error === renderError));

  await f.core.unmountAll();
  assert.equal(f.roots[0].unmountCalls, 1);
  assert.throws(() => ui.openPage("home"), /no longer active/);
});

test("uncaught and early render callbacks recover once and preserve the caller observer", async () => {
  const renderError = new Error("uncaught render error");
  const callbackError = new Error("observer failed");
  const observations = [];
  const rootOptions = {
    identifierPrefix: "observed-",
    onUncaughtError(error, errorInfo) {
      observations.push({ error, errorInfo });
      throw callbackError;
    },
  };
  const f = uiPluginFixture({ rootOptions });
  const { service: ui } = await f.mountUi({ rootOptions });
  ui.registerPage(page("home"));
  await f.notifyReady();

  const root = f.roots[0];
  const errorInfo = { componentStack: "<Home />" };
  root.options.onUncaughtError(renderError, errorInfo);
  root.options.onUncaughtError(new Error("duplicate uncaught error"), errorInfo);
  await flushUiMicrotasks();

  assert.equal(root.renderCalls.length, 2, "duplicate uncaught errors schedule only one fallback render");
  assert.equal(root.unmountCalls, 0);
  assert.equal(f.core.isMounted("ui"), true);
  assert.equal(ui.getSnapshot().current.id, "home");
  assert.equal(observations.length, 2);
  assert.equal(observations[0].error, renderError);
  assert.equal(observations[0].errorInfo, errorInfo);
  assert.equal(observations[1].errorInfo, errorInfo);
  assert.ok(f.logs.some(([message, detail]) => message === "UI render error observer failed." && detail.error === callbackError));
  assert.equal(renderedErrorPage(f, root).props.role, "alert");
  await f.core.unmount("ui");

  const early = uiPluginFixture({ renderErrorOnce: new Error("synchronous") });
  const { service: earlyUi } = await early.mountUi();
  earlyUi.registerPage(page("home"));
  early.controls.uncaughtErrorDuringRender = new Error("uncaught during initial render");
  await early.notifyReady();
  await flushUiMicrotasks();
  assert.equal(early.roots[0].renderCalls.length, 2, "an error raised during the initial render recovers after ready notification");
  assert.equal(early.core.isMounted("ui"), true);
  assert.equal(early.roots[0].unmountCalls, 0);
  await early.core.unmount("ui");
});

test("a persistent error page render failure is logged once without retrying or unmounting", async () => {
  const f = uiPluginFixture({ renderError: new Error("persistent failure") });
  const { service: ui } = await f.mountUi();
  ui.registerPage(page("home"));
  await f.notifyReady();
  await flushUiMicrotasks();
  await flushUiMicrotasks();

  assert.equal(f.roots[0].renderCalls.length, 2, "the failed fallback is not retried");
  assert.equal(f.roots[0].unmountCalls, 0);
  assert.equal(f.logs.filter(([message]) => message === "UI error page rendering failed.").length, 1);
  await f.core.unmount("ui");
  assert.equal(f.roots[0].unmountCalls, 1);
});

test("deactivation cancels a pending recovery and ignores later uncaught callbacks", async () => {
  const f = uiPluginFixture();
  const { service: ui } = await f.mountUi();
  ui.registerPage(page("home"));
  await f.notifyReady();
  const root = f.roots[0];
  const onUncaughtError = root.options.onUncaughtError;

  onUncaughtError(new Error("queued before stop"), { componentStack: "" });
  await f.core.unmount("ui");
  assert.equal(root.unmountCalls, 1);
  await flushUiMicrotasks();
  onUncaughtError(new Error("late after stop"), { componentStack: "" });
  await flushUiMicrotasks();

  assert.equal(root.renderCalls.length, 1, "neither the queued recovery nor a late callback revives the root");
  assert.equal(root.unmountCalls, 1);
  assert.throws(() => ui.openPage("home"), /no longer active/);
});
