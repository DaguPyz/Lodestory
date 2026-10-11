import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, deferred, flushStartup } from "./helpers/mainStartupFixture.mjs";

function themeKey(fixture) {
  return fixture.loadModule("theme/themeService.ts").themeKey;
}

function renderedTree(fixture) {
  assert.equal(fixture.roots.length, 1);
  return fixture.roots[0].tree;
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

function reportedFailure(fixture) {
  const entry = fixture.logs.find((value) => value?.level === "error");
  assert.ok(entry, "startup failure should be reported");
  assert.equal(entry.args[0], "Application failed to start.");
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
  for (const key of ["listenerErrors", "rollbackErrors", "cleanupErrors"]) {
    for (const entry of value[key] ?? []) collectErrors(entry, found, seen);
  }
  return found;
}

test("the entry delegates UI composition to the plugin catalog", async () => {
  const fixture = createMainFixture();

  fixture.start();
  await flushStartup();

  assert.deepEqual(fixture.catalogPluginIds, ["ui", "theme", "context-menu", "app"]);
  const entryImports = fixture.moduleImports
    .filter(({ from }) => from === "main.tsx")
    .map(({ specifier }) => specifier);
  assert.ok(entryImports.includes("./app/appPlugins"));
  for (const hardcodedUiImport of [
    "react",
    "react-dom/client",
    "./App",
    "./components/context-menu",
    "./theme/ThemeProvider",
    "./theme/themeService",
    "./styles.css",
  ]) {
    assert.ok(!entryImports.includes(hardcodedUiImport), `main.tsx should not import ${hardcodedUiImport}`);
  }
  assert.ok(fixture.moduleImports.some(({ from }) => from === "components/context-menu/contextMenuPlugin.tsx"),
    "the context-menu plugin source should run in the fixture");
  assert.equal(fixture.lifecycle.at(-1), "activate:app:complete");
  assert.ok(fixture.logs.indexOf("activate:app:complete") < fixture.logs.indexOf("plugins-ready.emit"));
  assert.ok(fixture.logs.indexOf("plugins-ready.emit") < fixture.logs.indexOf("root.render"));

  const tree = renderedTree(fixture);
  assert.equal(tree.type, fixture.React.StrictMode);
  const contextMenu = tree.props.children;
  assert.equal(contextMenu.type, fixture.components.ContextMenuProvider);
  const themeProvider = contextMenu.props.children;
  assert.equal(themeProvider.type, fixture.components.ThemeProvider);
  assert.equal(themeProvider.props.children.type, fixture.components.App);
  assert.equal(themeProvider.props.service, fixture.getService(themeKey(fixture)));
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

test("a missing theme capability rolls back before App is registered or rendered", async () => {
  const fixture = createMainFixture();
  fixture.omitThemeService();

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.equal(fixture.lifecycle.includes("activate:app:complete"), false);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.createdCores.at(-1).isMounted("theme"), false);
});

test("createRoot and render failures stop the runtime", async (t) => {
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

  await t.test("render throws", async () => {
    const fixture = createMainFixture();
    fixture.faults.renderError = new Error("render failed");

    fixture.start();
    await flushStartup();

    assert.equal(fixture.roots.length, 1);
    errorPage(fixture);
    assert.ok(fixture.logs.indexOf("root.unmount") < fixture.logs.indexOf("channel.close"));
    assert.ok(fixture.channels[0].closed);
  });
});

test("an asynchronous React error unmounts the UI before stopping its providers", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("uncaught render error");

  fixture.start();
  await flushStartup();
  fixture.rootCalls[0].options.onUncaughtError(renderError);
  fixture.rootCalls[0].options.onUncaughtError(new Error("duplicate render error"));
  await flushStartup();

  errorPage(fixture);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.equal(fixture.logs.filter((entry) => entry === "channel.close").length, 1);
  assert.ok(fixture.logs.indexOf("root.unmount") < fixture.logs.indexOf("channel.close"));
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(reportedFailure(fixture).startupError, renderError);
});

test("an early asynchronous React error waits for the runtime before cleaning it up", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("uncaught during initial render");
  fixture.faults.uncaughtErrorDuringRender = renderError;

  fixture.start();
  await flushStartup();

  errorPage(fixture);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.equal(reportedFailure(fixture).startupError, renderError);
});

test("cleanup failures are reported with the original uncaught error", async () => {
  const fixture = createMainFixture();
  const cleanupError = new Error("theme cleanup failed");
  const unmountError = new Error("React unmount failed");
  const startupError = new Error("uncaught render error");
  fixture.setCleanupError(cleanupError);
  fixture.faults.unmountError = unmountError;

  fixture.start();
  await flushStartup();
  fixture.rootCalls[0].options.onUncaughtError(startupError);
  await flushStartup();

  const report = reportedFailure(fixture);
  assert.equal(report.startupError, startupError);
  assert.ok(collectErrors(report.cleanupErrors).includes(unmountError));
  assert.ok(collectErrors(report.cleanupErrors).includes(cleanupError));
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.window.location.reloadCalls, 0);
  errorPage(fixture).children[2].click();
  assert.equal(fixture.window.location.reloadCalls, 1);
});
