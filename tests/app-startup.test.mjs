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

test("the entry waits for native theme setup before creating the React root", async () => {
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

  const tree = renderedTree(fixture);
  assert.equal(tree.type, fixture.React.StrictMode);
  const contextMenu = tree.props.children;
  assert.equal(contextMenu.type, fixture.components.ContextMenuProvider);
  const themeProvider = contextMenu.props.children;
  assert.equal(themeProvider.type, fixture.components.ThemeProvider);
  assert.equal(themeProvider.props.children.type, fixture.components.App);
  assert.equal(themeProvider.props.service, fixture.getService(themeKey(fixture)));
});

test("browser startup remains asynchronous and keeps StrictMode and both providers", async () => {
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
  fixture.setActivationError(new Error("theme activation failed"));

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.logs.filter(entry => entry === "channel.close").length, 1);
  assert.equal(fixture.logs.at(-1).level, "error");
});

test("a missing theme capability cleans up the mounted runtime without rendering App", async () => {
  const fixture = createMainFixture();
  fixture.omitThemeService();

  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  errorPage(fixture);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.createdCores.at(-1).isMounted("theme"), false);
  assert.equal(fixture.logs.at(-1).level, "error");
});

test("createRoot and render failures stop the runtime, unmounting any created root first", async (t) => {
  await t.test("createRoot throws", async () => {
    const fixture = createMainFixture();
    fixture.faults.createRootError = new Error("createRoot failed");

    fixture.start();
    await flushStartup();

    assert.equal(fixture.rootCalls.length, 1);
    assert.equal(fixture.roots.length, 0);
    errorPage(fixture);
    assert.equal(fixture.channels[0].closed, true);
  });

  await t.test("render throws", async () => {
    const fixture = createMainFixture();
    fixture.faults.renderError = new Error("render failed");

    fixture.start();
    await flushStartup();

    assert.equal(fixture.roots.length, 1);
    errorPage(fixture);
    assert.ok(fixture.logs.indexOf("root.unmount") < fixture.logs.indexOf("channel.close"));
    assert.equal(fixture.channels[0].closed, true);
  });
});

test("React's asynchronous uncaught-error callback unmounts before stopping plugins", async () => {
  const fixture = createMainFixture();
  const renderError = new Error("uncaught render error");

  fixture.start();
  await flushStartup();
  fixture.rootCalls[0].options.onUncaughtError(renderError);
  fixture.rootCalls[0].options.onUncaughtError(new Error("duplicate render error"));
  await flushStartup();

  errorPage(fixture);
  assert.equal(fixture.logs.filter(entry => entry === "root.unmount").length, 1);
  assert.equal(fixture.logs.filter(entry => entry === "channel.close").length, 1);
  assert.ok(fixture.logs.indexOf("root.unmount") < fixture.logs.indexOf("channel.close"));
  assert.equal(fixture.channels[0].closed, true);
  const reported = fixture.logs.find(entry => entry.level === "error");
  assert.equal(reported.args[0], "Application failed to start.");
  assert.equal(reported.args[1].startupError, renderError);
});

test("cleanup failures are reported together with the original uncaught error", async () => {
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

  const reported = fixture.logs.find(entry => entry.level === "error");
  assert.equal(reported.args[1].startupError, startupError);
  assert.equal(reported.args[1].cleanupErrors.length, 2);
  assert.equal(reported.args[1].cleanupErrors[0], unmountError);
  assert.equal(reported.args[1].cleanupErrors[1].cleanupErrors[0].error, cleanupError);
  assert.equal(fixture.channels[0].closed, true);
  assert.equal(fixture.window.location.reloadCalls, 0);
  errorPage(fixture).children[2].click();
  assert.equal(fixture.window.location.reloadCalls, 1);
});
