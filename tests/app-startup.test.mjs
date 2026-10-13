import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, deferred, flushStartup } from "./helpers/mainStartupFixture.mjs";

function themeKey(fixture) {
  return fixture.requireSdk("@lodestory/sdk/theme").themeKey;
}

function renderedTree(fixture) {
  assert.equal(fixture.roots.length, 1);
  return fixture.roots[0].tree;
}

function containsType(value, expectedType) {
  if (Array.isArray(value)) return value.some((item) => containsType(item, expectedType));
  if (!value || typeof value !== "object") return false;
  if (value.type === expectedType) return true;
  return containsType(value.props?.children, expectedType);
}

function errorPage(fixture) {
  assert.equal(fixture.rootElement.children.length, 1);
  const page = fixture.rootElement.children[0];
  assert.equal(page.className, "app-startup-error");
  assert.equal(page.attributes.role, "alert");
  assert.equal(page.children[0].textContent, "应用启动失败");
  assert.equal(page.children[2].textContent, "重新加载");
  return page;
}

function uiErrorPage(fixture) {
  const UiErrorPage = fixture.loadModule("plugins/ui/UiErrorPage.tsx").UiErrorPage;
  const tree = renderedTree(fixture);
  assert.ok(containsType(tree, UiErrorPage), "the same React root should render UiErrorPage");
  return tree;
}

function reportedFailure(fixture) {
  const entry = fixture.logs.find((value) => value?.level === "error");
  assert.ok(entry, "startup failure should be reported");
  assert.equal(entry.args[0], "Application failed to start.");
  return entry.args[1];
}

function reportedUiRenderingError(fixture) {
  const entry = fixture.logs.find((value) => value?.level === "error" && value.args[0] === "UI rendering failed.");
  assert.ok(entry, "the UI render error should be reported");
  return entry.args[1];
}

function collectErrors(value, found = [], seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  found.push(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectErrors(entry, found, seen);
    return found;
  }
  for (const key of ["startupError", "activationError", "cleanupError", "error"]) {
    collectErrors(value[key], found, seen);
  }
  for (const key of ["errors", "listenerErrors", "rollbackErrors", "cleanupErrors"]) {
    for (const entry of value[key] ?? []) collectErrors(entry, found, seen);
  }
  return found;
}

test("the entry delegates UI composition and page registration to the plugin catalog", async () => {
  const fixture = createMainFixture();

  fixture.start();
  await flushStartup();

  assert.deepEqual(fixture.catalogPluginIds, ["ui", "theme", "context-menu", "welcome", "editor", "settings"]);
  assert.deepEqual(fixture.appPluginsCalls, [[]]);
  const entryImports = fixture.moduleImports
    .filter(({ from }) => from === "main.tsx")
    .map(({ specifier }) => specifier);
  assert.ok(entryImports.includes("./app/appPlugins"));
  for (const hardcodedUiImport of [
    "react",
    "react-dom/client",
    "./App",
    "./plugins/context-menu",
    "./plugins/theme/ThemeProvider",
    "./plugins/theme/themePlugin",
    "./plugins/welcome/welcomePlugin",
    "./plugins/editor/editorPlugin",
    "./plugins/settings/settingsPlugin",
    "./styles.css",
  ]) {
    assert.ok(!entryImports.includes(hardcodedUiImport), `main.tsx should not import ${hardcodedUiImport}`);
  }
  assert.ok(!fixture.moduleImports.some(({ from }) => from === "App.tsx"), "the legacy App should not be loaded");
  assert.ok(!fixture.moduleImports.some(({ from }) => from.startsWith("plugins/workspace/")),
    "the legacy workspace page plugin should not be loaded");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/context-menu/contextMenuPlugin.tsx"),
    "the context-menu plugin source should run in the fixture");
  for (const pagePlugin of ["welcome", "editor", "settings"]) {
    assert.ok(fixture.moduleImports.some(({ from }) => from === `plugins/${pagePlugin}/${pagePlugin}Plugin.tsx`),
      `the ${pagePlugin} page plugin source should run in the fixture`);
    assert.ok(fixture.lifecycle.includes(`activate:${pagePlugin}:complete`),
      `the ${pagePlugin} page plugin should activate`);
  }
  assert.equal(fixture.lifecycle.at(-1), "activate:settings:complete");
  assert.ok(fixture.logs.indexOf("activate:settings:complete") < fixture.logs.indexOf("plugins-ready.emit"));
  assert.ok(fixture.logs.indexOf("plugins-ready.emit") < fixture.logs.indexOf("root.render"));

  const tree = renderedTree(fixture);
  assert.equal(tree.type, fixture.React.StrictMode);
  const contextMenu = tree.props.children;
  assert.equal(contextMenu.type, fixture.components.ContextMenuProvider);
  const themeProvider = contextMenu.props.children;
  assert.equal(themeProvider.type, fixture.components.ThemeProvider);
  assert.equal(typeof fixture.UiPages, "function", "the real UI pages component should be loaded");
  assert.equal(themeProvider.props.children.type, fixture.UiPages);
  assert.equal(themeProvider.props.service, fixture.getService(themeKey(fixture)));

  const uiService = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  const snapshot = uiService.getSnapshot();
  assert.equal(snapshot.current.id, "welcome");
  assert.deepEqual(Array.from(snapshot.pages, ({id, active}) => ({id, active})), [{id: "welcome", active: true}]);
  const initialPageTree = fixture.UiPages(themeProvider.props.children.props);
  assert.ok(containsType(initialPageTree, fixture.components.WelcomePage), "the welcome plugin should render its page");

  // Visiting each route proves that all three page plugins registered with the real UI service.
  uiService.openPage("editor", { project: { id: "novel-1", name: "Novel", path: "/novel" } });
  uiService.openPage("settings");
  const visited = uiService.getSnapshot();
  assert.deepEqual(Array.from(visited.pages, ({id, active}) => ({id, active})), [
    {id: "welcome", active: false},
    {id: "editor", active: false},
    {id: "settings", active: true},
  ]);
  const visitedPageTree = fixture.UiPages(themeProvider.props.children.props);
  const renderedPages = visitedPageTree.props.children;
  const renderedPage = (id) => renderedPages.find((page) => page.key === id).props.children;
  const welcomePage = renderedPage("welcome");
  const editorShell = renderedPage("editor");
  assert.equal(editorShell.type, fixture.components.PageShell);
  assert.equal(editorShell.props.showBrowserTitlebar, false);
  const editorPage = editorShell.props.children;
  const settingsPage = renderedPage("settings");
  assert.equal(welcomePage.type, fixture.components.WelcomePage);
  assert.equal(welcomePage.props.active, false);
  assert.equal(typeof welcomePage.props.onOpenProject, "function");
  assert.equal(typeof welcomePage.props.onOpenSettings, "function");
  assert.equal(editorPage.type, fixture.components.EditorPage);
  assert.equal(editorPage.props.projectName, "Novel");
  assert.equal(editorPage.props.projectPath, "/novel");
  assert.equal(editorPage.props.active, false);
  assert.equal(typeof editorPage.props.onBack, "function");
  assert.equal(typeof editorPage.props.onOpenSettings, "function");
  assert.equal(settingsPage.type, fixture.components.ThemeSettingsPage);
  assert.equal(settingsPage.props.active, true);
  assert.equal(typeof settingsPage.props.onBack, "function");
});

test("the entry waits for native theme setup before the plugin catalog renders", async () => {
  const nativeReady = deferred();
  const fixture = createMainFixture({ nativeSetGate: nativeReady.promise });

  fixture.start();
  await flushStartup();
  assert.equal(fixture.nativeCalls.length, 1);
  assert.equal(fixture.rootCalls.length, 0);

  nativeReady.resolve();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.nativeCalls.length, 1);
  assert.equal(fixture.channels.length, 1);
  assert.equal(fixture.mediaListeners.size, 1);
  assert.equal(renderedTree(fixture).type, fixture.React.StrictMode);
});

test("browser startup remains asynchronous and retains both UI wrappers", async () => {
  const fixture = createMainFixture({ tauri: false });

  fixture.start();
  assert.equal(fixture.rootCalls.length, 0);
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.nativeCalls.length, 0);
  const tree = renderedTree(fixture);
  assert.equal(tree.type, fixture.React.StrictMode);
  assert.equal(tree.props.children.type, fixture.components.ContextMenuProvider);
  assert.equal(tree.props.children.props.children.type, fixture.components.ThemeProvider);
});

test("theme startup errors remain recoverable and the app still renders", async () => {
  const fixture = createMainFixture({ nativeSetError: true });

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.getService(themeKey(fixture)).getSnapshot().windowError, true);
  assert.equal(fixture.rootElement.children.length, 0);
});

test("a plugin activation failure rolls back resources and shows the native error page", async () => {
  const fixture = createMainFixture();
  const activationError = new Error("theme activation failed");
  fixture.setActivationError(activationError);

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.ok(collectErrors(reportedFailure(fixture)).includes(activationError));
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.logs.filter((entry) => entry === "channel.close").length, 1);
});

test("a missing theme capability rolls back before page plugins register or render", async () => {
  const fixture = createMainFixture();
  fixture.omitThemeService();

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.equal(fixture.lifecycle.some((entry) => /^activate:(welcome|editor|settings):complete$/.test(entry)), false);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.createdCores.at(-1).isMounted("theme"), false);
});

test("createRoot failures roll back startup, while render failures recover in the same root", async (t) => {
  await t.test("createRoot throws", async () => {
    const fixture = createMainFixture();
    fixture.faults.createRootError = new Error("createRoot failed");

    fixture.start();
    await flushStartup();

    assert.equal(fixture.rootCalls.length, 1);
    assert.equal(fixture.roots.length, 0);
    errorPage(fixture);
    assert.ok(fixture.channels[0].closed);
  });

  await t.test("the first render throws once", async () => {
    const fixture = createMainFixture();
    const renderError = new Error("render failed");
    fixture.faults.renderErrorOnce = renderError;

    fixture.start();
    await flushStartup();

    assert.equal(fixture.rootCalls.length, 1);
    assert.equal(fixture.roots.length, 1);
    assert.equal(fixture.roots[0].renderCalls.length, 2);
    uiErrorPage(fixture);
    assert.equal(fixture.lifecycle.filter((entry) => entry.startsWith("activate:") && entry.endsWith(":complete")).length, fixture.catalogPluginIds.length);
    assert.equal(fixture.lifecycle.some((entry) => entry.startsWith("deactivate:")), false);
    assert.equal(fixture.channels[0].closed, false);
    assert.ok(fixture.mediaListeners.size > 0);
    assert.ok(fixture.nativeListeners.size > 0);
    assert.equal(reportedUiRenderingError(fixture).error, renderError);
  });
});

test("an asynchronous React error replaces the failed tree without stopping its providers", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("uncaught render error");

  fixture.start();
  await flushStartup();
  fixture.rootCalls[0].options.onUncaughtError(renderError);
  fixture.rootCalls[0].options.onUncaughtError(new Error("duplicate render error"));
  await flushStartup();

  uiErrorPage(fixture);
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.roots[0].renderCalls.length, 2);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 0);
  assert.equal(fixture.lifecycle.some((entry) => entry.startsWith("deactivate:")), false);
  assert.equal(fixture.channels[0].closed, false);
  assert.ok(fixture.mediaListeners.size > 0);
  assert.ok(fixture.nativeListeners.size > 0);
  assert.equal(reportedUiRenderingError(fixture).error, renderError);
});

test("an initial render error is recovered after React reports it", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("uncaught during initial render");
  fixture.faults.uncaughtErrorDuringRender = renderError;

  fixture.start();
  await flushStartup();

  uiErrorPage(fixture);
  assert.equal(fixture.roots[0].renderCalls.length, 2);
  assert.equal(fixture.channels[0].closed, false);
  assert.equal(fixture.lifecycle.some((entry) => entry.startsWith("deactivate:")), false);
  assert.equal(reportedUiRenderingError(fixture).error, renderError);
});

test("a persistent fallback render error is reported once without retrying or stopping plugins", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("persistent render error");
  fixture.faults.renderError = renderError;
  fixture.start();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.roots[0].renderCalls.length, 2);
  const entry = fixture.logs.find((value) => value?.level === "error" && value.args[0] === "UI error page rendering failed.");
  assert.ok(entry);
  assert.equal(entry.args[1].renderError, renderError);
  assert.equal(entry.args[1].errorPageError, renderError);
  assert.equal(fixture.logs.filter((value) => value?.level === "error" && value.args[0] === "UI error page rendering failed.").length, 1);
  assert.equal(fixture.logs.filter((value) => value === "root.unmount").length, 0);
  assert.equal(fixture.lifecycle.some((value) => value.startsWith("deactivate:")), false);
  assert.equal(fixture.channels[0].closed, false);
});

test("startup rollback failures report both the activation and cleanup errors", async () => {
  const fixture = createMainFixture();
  const cleanupError = new Error("theme cleanup failed");
  const startupError = new Error("createRoot failed");
  fixture.setCleanupError(cleanupError);
  fixture.faults.createRootError = startupError;

  fixture.start();
  await flushStartup();
  await flushStartup();

  const report = reportedFailure(fixture);
  assert.ok(collectErrors(report.startupError).includes(startupError));
  assert.ok(collectErrors(report.cleanupErrors).includes(cleanupError));
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.window.location.reloadCalls, 0);
  errorPage(fixture).children[2].click();
  assert.equal(fixture.window.location.reloadCalls, 1);
});

test("a missing #root rolls back startup and is reported without throwing from the UI fallback", async () => {
  const fixture = createMainFixture({ missingRoot: true });
  fixture.start();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.rootElement.children.length, 0);
  assert.ok(fixture.channels.length > 0);
  assert.equal(fixture.channels[0].closed, true);
  assert.ok(fixture.lifecycle.some((entry) => entry.startsWith("deactivate:")));
  const report = reportedFailure(fixture);
  assert.ok(collectErrors(report.startupError).some((error) => String(error?.message ?? error).includes("#root")));
  assert.equal(fixture.window.location.reloadCalls, 0);
});

test("the UI plugin resolves the app root container itself", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.rootCalls[0].container, fixture.rootElement);
});
