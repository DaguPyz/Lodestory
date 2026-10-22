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

function findElement(value, expectedType) {
  if (Array.isArray(value)) return value.map(item => findElement(item, expectedType)).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  if (value.type === expectedType) return value;
  return findElement(value.props?.children, expectedType);
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

function rootRenderFallback(fixture) {
  assert.equal(fixture.roots.length, 1);
  const tree = fixture.roots[0].renderCalls.at(-1);
  assert.equal(tree.type, fixture.React.StrictMode);
  const fallback = tree.props.children;
  assert.equal(fallback.type.name, "RootRenderFallback");
  const page = fallback.type(fallback.props);
  assert.equal(page.type, "main");
  assert.equal(page.props.className, "app-startup-error");
  assert.equal(page.props.role, "alert");
  return fallback;
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

  assert.deepEqual(fixture.catalogPluginIds, ["config", "error-ui", "ui", "theme", "builtin-themes", "context-menu", "window-shell", "navigation-layout", "default-layout", "workbench", "documents", "project-management", "outline-design", "body-editor", "markdown-editor", "rich-text-editor", "document-tabs", "writing-status", "workbench-toolbar", "welcome", "settings"]);
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier === "./MarkdownEditor"), false,
  "application startup does not import the Milkdown component");
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier.startsWith("@milkdown/")), false,
    "application startup does not load Milkdown packages");
  assert.deepEqual(fixture.appPluginsCalls, [[]]);
  const {configKey} = fixture.requireSdk("@lodestory/sdk/config");
  const {bodyEditorDefaultEditorsConfig} = fixture.requireSdk("@lodestory/sdk/body-editor");
  assert.deepEqual(Object.fromEntries(Object.entries(
    fixture.getService(configKey).getSnapshot(bodyEditorDefaultEditorsConfig),
  )), {
    markdown: "milkdown",
    "plain-text": "quill",
    "rich-delta": "quill",
  }, "application defaults route rich and plain text through the rich-text plugin");
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier === "./RichTextEditor"), false,
    "application startup registers the rich-text editor without loading its component");
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier === "quill" || specifier.startsWith("quill/")), false,
    "application startup does not import Quill runtime packages");
  assert.equal(fixture.tauriCalls.some(({command}) => command === "list_system_font_families"), false,
    "lazy rich-text editor registration does not enumerate system fonts");
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
    "./plugins/project-management/projectManagementPlugin",
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
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/navigation-layout/navigationLayoutPlugin.tsx"),
    "the navigation layout plugin should own the shared welcome and settings frame");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/window-shell/windowShellPlugin.tsx"),
    "the window shell plugin should own the shared platform window frame");
  assert.ok(fixture.logs.indexOf("activate:window-shell:complete") < fixture.logs.indexOf("activate:navigation-layout:begin"));
  assert.ok(fixture.logs.indexOf("activate:navigation-layout:complete") < fixture.logs.indexOf("activate:welcome:begin"));
  assert.ok(fixture.logs.indexOf("activate:navigation-layout:complete") < fixture.logs.indexOf("activate:settings:begin"));
  assert.ok(fixture.lifecycle.includes("activate:error-ui:complete"));
  for (const pagePlugin of ["workbench", "welcome", "settings"]) {
    assert.ok(fixture.moduleImports.some(({ from }) => from === `plugins/${pagePlugin}/${pagePlugin}Plugin.tsx`),
      `the ${pagePlugin} page plugin source should run in the fixture`);
    assert.ok(fixture.lifecycle.includes(`activate:${pagePlugin}:complete`),
      `the ${pagePlugin} page plugin should activate`);
  }
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/documents/documentsPlugin.ts"), "the documents plugin source should run in the fixture");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/project-management/projectManagementPlugin.tsx"), "the project management plugin source should run in the fixture");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/outline-design/outlineDesignPlugin.tsx"), "the outline-design plugin source should run in the fixture");
  assert.ok(fixture.lifecycle.includes("activate:documents:complete"), "the documents service should activate");
  assert.ok(fixture.logs.indexOf("activate:workbench:complete") < fixture.logs.indexOf("activate:documents:begin"));
  assert.ok(fixture.logs.indexOf("activate:documents:complete") < fixture.logs.indexOf("activate:project-management:begin"), "the document service must be available before project management activation");
  assert.ok(fixture.logs.indexOf("activate:project-management:complete") < fixture.logs.indexOf("activate:body-editor:begin"), "documents and project management activate before the body editor");
  assert.ok(fixture.logs.indexOf("activate:body-editor:complete") < fixture.logs.indexOf("activate:workbench-toolbar:begin"), "the body editor activates before the workbench toolbar");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/body-editor/bodyEditorPlugin.tsx"),
    "the body editor plugin source should run in the fixture");
  assert.ok(fixture.lifecycle.includes("activate:body-editor:complete"), "the body editor plugin should activate");
  assert.ok(fixture.moduleImports.some(({ from }) => from === "plugins/workbench-toolbar/workbenchToolbarPlugin.tsx"),
    "the workbench toolbar plugin source should run in the fixture");
  assert.ok(fixture.lifecycle.includes("activate:workbench-toolbar:complete"), "the workbench toolbar plugin should activate");
  assert.ok(fixture.lifecycle.includes("activate:project-management:complete"), "the project management plugin should activate");
  assert.ok(fixture.lifecycle.includes("activate:outline-design:complete"), "the outline-design plugin should activate");
  assert.ok(fixture.logs.indexOf("activate:config:complete") < fixture.logs.indexOf("activate:ui:begin"), "the config service must be available before UI activation");
  assert.ok(fixture.logs.indexOf("activate:workbench:complete") < fixture.logs.indexOf("activate:welcome:begin"), "the workbench page registers before the welcome page");
  assert.equal(fixture.lifecycle.at(-1), "activate:settings:complete");
  assert.ok(fixture.logs.indexOf("activate:settings:complete") < fixture.logs.indexOf("plugins-ready.emit"));
  assert.ok(fixture.logs.indexOf("plugins-ready.emit") < fixture.logs.indexOf("root.render"));

  const tree = renderedTree(fixture);
  assert.equal(tree.type, fixture.React.StrictMode);
  const errorUi = tree.props.children;
  assert.equal(errorUi.type, fixture.components.ErrorBoundary);
  const contextMenu = errorUi.props.children;
  assert.equal(contextMenu.type, fixture.components.ContextMenuProvider);
  const themeProvider = contextMenu.props.children;
  assert.equal(themeProvider.type, fixture.components.ThemeProvider);
  assert.equal(typeof fixture.UiPages, "function", "the real UI pages component should be loaded");
  const pagesElement = findElement(themeProvider.props.children, fixture.UiPages);
  assert.ok(pagesElement, "the project dialog wrapper should retain the UI pages below it");
  assert.equal(themeProvider.props.service, fixture.getService(themeKey(fixture)));
  const errorUiService = fixture.getService(fixture.requireSdk("@lodestory/sdk/error").errorUiKey);
  assert.equal(errorUiService.ErrorBoundary, fixture.components.ErrorBoundary);
  assert.equal(errorUiService.ErrorView, fixture.components.ErrorView);

  const uiService = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  const snapshot = uiService.getSnapshot();
  assert.equal(snapshot.current.id, "welcome");
  assert.deepEqual(Array.from(snapshot.pages, ({id, active}) => ({id, active})), [{id: "welcome", active: true}]);
  const initialPageTree = fixture.UiPages(pagesElement.props);
  assert.ok(containsType(initialPageTree, fixture.components.WelcomePage), "the welcome plugin should render its page");
  assert.ok(findElement(themeProvider.props.children, fixture.components.ToolbarRecovery), "the toolbar recovery entry is mounted in the UI wrapper");

  // Visiting each route proves that all three page plugins registered with the real UI service.
  await uiService.openPage("editor", { project: { id: "novel-1", name: "Novel", path: "/novel" } });
  await uiService.openPage("settings");
  const visited = uiService.getSnapshot();
  assert.deepEqual(Array.from(visited.pages, ({id, active}) => ({id, active})), [
    {id: "welcome", active: false},
    {id: "editor", active: false},
    {id: "settings", active: true},
  ]);
  const visitedPageTree = fixture.UiPages(pagesElement.props);
  const renderedPages = visitedPageTree.props.children;
  const renderedPage = (id) => renderedPages.find((page) => page.key === id).props.children;
  const welcomeShell = renderedPage("welcome");
  assert.equal(welcomeShell.type, fixture.components.PageShell);
  assert.equal(welcomeShell.props.showBrowserTitlebar, undefined, "the browser titlebar uses the shell default");
  const welcomeLayout = welcomeShell.props.children;
  assert.equal(welcomeLayout.type, fixture.components.NavigationLayout);
  const welcomeBoundary = welcomeLayout.props.children;
  assert.equal(welcomeBoundary.type, fixture.components.ErrorBoundary);
  const welcomePage = welcomeBoundary.props.children;
  const editorBoundary = renderedPage("editor");
  assert.equal(editorBoundary.type, fixture.components.ErrorBoundary);
  const editorShell = editorBoundary.props.children;
  assert.equal(editorShell.type, fixture.components.PageShell);
  assert.equal(editorShell.props.showBrowserTitlebar, false);
  const editorPage = editorShell.props.children;
  const settingsShell = renderedPage("settings");
  assert.equal(settingsShell.type, fixture.components.PageShell);
  const settingsLayout = settingsShell.props.children;
  assert.equal(settingsLayout.type, fixture.components.NavigationLayout);
  const settingsBoundary = settingsLayout.props.children;
  assert.equal(settingsBoundary.type, fixture.components.ErrorBoundary);
  const settingsPage = settingsBoundary.props.children;
  assert.equal(welcomePage.type, fixture.components.WelcomePage);
  assert.equal(welcomePage.props.active, false);
  assert.equal(typeof welcomePage.props.onOpenProject, "function");
  assert.equal("onOpenSettings" in welcomePage.props, false);
  assert.equal(editorPage.type, fixture.components.WorkbenchPage);
  const workbenchKey = fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey;
  const layoutKey = fixture.requireSdk("@lodestory/sdk/layout").layoutKey;
  assert.equal(editorPage.props.workbench, fixture.getService(workbenchKey));
  assert.equal(editorPage.props.layout, fixture.getService(layoutKey));
  assert.equal(editorPage.props.active, false);
  assert.equal(settingsPage.type, fixture.components.ThemeSettingsPage);
  assert.equal(settingsPage.props.active, true);
  assert.equal(typeof settingsPage.props.onBack, "function");
});

test("the config service selects the configured welcome page after every page is registered", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();

  const ui = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  assert.equal(ui.getSnapshot().current.id, "welcome", "config.json selects welcome even though workbench registered its page first");
  assert.deepEqual(fixture.appPluginsCalls, [[]], "the app assembles the catalog without runtime configuration arguments");
});

test("a valid user startup-page override is applied after additional pages register", async () => {
  const fixture = createMainFixture({
    configOverrides: {"ui.initialPage": "launch-target"},
    additionalPlugins: ({requireSdk}) => {
      const {uiKey} = requireSdk("@lodestory/sdk/ui");
      return [{
        id: "test-launch-target",
        requires: [uiKey],
        provides: [],
        activate(context) {
          context.get(uiKey).registerPage({id: "launch-target", render: () => fixture.components.WelcomePage({})});
        },
        deactivate() {},
      }];
    },
  });
  fixture.start();
  await flushStartup();

  const ui = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  assert.equal(ui.getSnapshot().current.id, "launch-target");
  assert.equal(fixture.roots.length, 1);
});

test("an invalid user startup-page value falls back to the base configuration", async () => {
  const fixture = createMainFixture({configOverrides: {"ui.initialPage": false}});
  fixture.start();
  await flushStartup();

  const ui = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  assert.equal(ui.getSnapshot().current.id, "welcome");
  assert.ok(fixture.logs.some(entry => entry?.level === "warn" || entry?.level === "error"), "the invalid user override should be reported");
});

test("an unregistered configured startup page aborts startup and rolls back plugins", async () => {
  const fixture = createMainFixture({configOverrides: {"ui.initialPage": "missing-page"}});
  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.ok(collectErrors(reportedFailure(fixture)).some(error => /page.*missing-page|missing-page.*page/i.test(error.message ?? "")));
  for (const id of fixture.catalogPluginIds) assert.equal(fixture.createdCores.at(-1).isMounted(id), false);
});

test("changing the restart-only startup page config does not navigate the running UI", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();
  const ui = fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
  const config = fixture.getService(fixture.requireSdk("@lodestory/sdk/config").configKey);
  const {uiInitialPageConfig} = fixture.requireSdk("@lodestory/sdk/ui");

  await config.set(uiInitialPageConfig, "settings");

  assert.equal(config.getSnapshot(uiInitialPageConfig), "settings");
  assert.equal(ui.getSnapshot().current.id, "welcome", "the new initial page is applied on the next startup only");
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
  assert.equal(tree.props.children.type, fixture.components.ErrorBoundary);
  assert.equal(tree.props.children.props.children.type, fixture.components.ContextMenuProvider);
  assert.equal(tree.props.children.props.children.props.children.type, fixture.components.ThemeProvider);
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
  assert.equal(fixture.channels.length, 0);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.logs.filter((entry) => entry === "channel.close").length, 0);
});

test("a missing theme capability rolls back before page plugins register or render", async () => {
  const fixture = createMainFixture();
  fixture.omitThemeService();

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.equal(fixture.lifecycle.some((entry) => /^activate:(welcome|editor|settings):complete$/.test(entry)), false);
  assert.equal(fixture.channels.length, 0);
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
    rootRenderFallback(fixture);
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

  rootRenderFallback(fixture);
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

  rootRenderFallback(fixture);
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
  const entry = fixture.logs.find((value) => value?.level === "error" && value.args[0] === "UI root fallback rendering failed.");
  assert.ok(entry);
  assert.equal(entry.args[1].renderError, renderError);
  assert.equal(entry.args[1].fallbackError, renderError);
  assert.equal(fixture.logs.filter((value) => value?.level === "error" && value.args[0] === "UI root fallback rendering failed.").length, 1);
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

test("all initial theme contributions are registered before the selected palette and native appearance are applied", async () => {
  const gate = deferred();
  const theme = { schemaVersion: 1, id: "example.initial.paper", name: "Paper", type: "light", colors: { "surface.content": "#EEDDCC" } };
  const fixture = createMainFixture({ nativeSetGate: gate.promise, themeDefinitions: [theme], preference: { mode: "fixed", themeId: theme.id } });
  fixture.start();
  await flushStartup();
  assert.ok(fixture.lifecycle.includes("activate:test-custom-themes:complete"));
  assert.equal(fixture.rootCalls.length, 0);
  assert.deepEqual(fixture.nativeCalls, ["light"]);
  assert.deepEqual(fixture.themeApplications, [{ id: theme.id, value: "#EEDDCC" }]);
  gate.resolve();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.getService(themeKey(fixture)).getSnapshot().theme.id, theme.id);
});

test("missing configured themes abort startup and roll back all plugins before React mounts", async () => {
  const fixture = createMainFixture({ omitBuiltinThemes: true });
  fixture.start();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.nativeCalls.length, 0);
  assert.equal(fixture.channels.length, 0);
  assert.deepEqual(fixture.themeApplications, []);
  errorPage(fixture);
  assert.ok(collectErrors(reportedFailure(fixture)).some(error => /Default theme.*not registered/.test(error.message ?? "")));
  for (const id of fixture.catalogPluginIds) assert.equal(fixture.createdCores.at(-1).isMounted(id), false);
});
