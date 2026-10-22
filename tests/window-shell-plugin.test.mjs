import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function findElement(value, predicate) {
  if (Array.isArray(value)) return value.map(item => findElement(item, predicate)).find(Boolean);
  if (predicate(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  return findElement(value.props?.children, predicate);
}

function renderedPage(fixture, ui, id) {
  const tree = fixture.UiPages({service: ui});
  const page = tree.props.children.find(item => item.key === id);
  assert.ok(page, `page '${id}' should be present in the UI tree`);
  const element = page.props.children;
  return element.type === fixture.components.ErrorBoundary ? element.props.children : element;
}

function replacementProvider(sdk, View) {
  const {windowShellKey} = sdk.requireSdk("@lodestory/sdk/window-shell");
  const {themeKey} = sdk.requireSdk("@lodestory/sdk/theme");
  return {
    id: "window-shell",
    requires: [themeKey],
    provides: [windowShellKey],
    activate(context) {
      context.provide(windowShellKey, Object.freeze({View}));
    },
  };
}

test("the actual shell shows the default browser titlebar and honors the hide option", async () => {
  const fixture = createMainFixture({tauri: false});
  fixture.start();
  await flushStartup();

  const {windowShellKey} = fixture.requireSdk("@lodestory/sdk/window-shell");
  const service = fixture.getService(windowShellKey);
  const view = service.View;
  assert.strictEqual(view, fixture.components.PageShell, "the provider exposes the real PageShell component");
  assert.strictEqual(fixture.getService(windowShellKey).View, view, "the component identity stays stable across lookups");
  assert.ok(Object.isFrozen(service));

  const browserShell = view({children: "welcome content"});
  assert.equal(browserShell.type, "div");
  assert.equal(browserShell.props.className, "app-shell");
  const titlebar = findElement(browserShell, element => element.type === "header" && element.props.className === "window-titlebar");
  assert.ok(titlebar, "the browser shell displays a titlebar by default");
  assert.equal(titlebar.props.children, "Lodestory");
  assert.equal(findElement(browserShell, element => element === "welcome content"), "welcome content");

  const hiddenTitlebarShell = view({children: "editor content", showBrowserTitlebar: false});
  assert.equal(findElement(hiddenTitlebarShell, element => element.type === "header" && element.props.className === "window-titlebar"), undefined);
  await fixture.createdCores.at(-1).unmountAll();
});

test("the actual shell omits the browser titlebar inside Tauri", async () => {
  const fixture = createMainFixture({tauri: true});
  fixture.start();
  await flushStartup();

  const {windowShellKey} = fixture.requireSdk("@lodestory/sdk/window-shell");
  const shell = fixture.getService(windowShellKey).View({children: "desktop content"});
  assert.equal(shell.props.className, "app-shell");
  assert.equal(findElement(shell, element => element.type === "header" && element.props.className === "window-titlebar"), undefined);
  await fixture.createdCores.at(-1).unmountAll();
});

test("replacing the window shell updates both navigation and workbench consumers", async () => {
  const ReplacementShell = function ReplacementShell() {};
  const fixture = createMainFixture({windowShellFactory: sdk => replacementProvider(sdk, ReplacementShell)});
  fixture.start();
  await flushStartup();

  const {windowShellKey} = fixture.requireSdk("@lodestory/sdk/window-shell");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const view = fixture.getService(windowShellKey).View;
  assert.strictEqual(view, ReplacementShell);
  const ui = fixture.getService(uiKey);
  const welcomeShell = renderedPage(fixture, ui, "welcome");
  assert.strictEqual(welcomeShell.type, view);
  assert.equal(welcomeShell.props.showBrowserTitlebar, undefined);

  const workbench = fixture.getService(workbenchKey);
  assert.equal(await workbench.openProject({id: "novel", name: "小说", path: "/stories/novel"}), true);
  const editorShell = renderedPage(fixture, ui, "editor");
  assert.strictEqual(editorShell.type, view);
  assert.equal(editorShell.props.showBrowserTitlebar, false);
  assert.equal(editorShell.props.children.type, fixture.components.WorkbenchPage);
  await fixture.createdCores.at(-1).unmountAll();
});

test("a missing shell provider blocks startup and leaves no root mounted", async () => {
  const fixture = createMainFixture({omitWindowShell: true});
  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.rootElement.children[0]?.className, "app-startup-error");
  const core = fixture.createdCores.at(-1);
  assert.equal(core.isMounted("window-shell"), false);
  assert.equal(core.isMounted("navigation-layout"), false);
  assert.equal(core.isMounted("workbench"), false);
});

test("the runtime protects the shell while its consumers are mounted", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();

  const core = fixture.createdCores.at(-1);
  await assert.rejects(core.unmount("window-shell"), /required by plugins: 'navigation-layout', 'workbench'/);
  assert.equal(core.isMounted("window-shell"), true);
  await core.unmountAll();
  assert.equal(core.isMounted("window-shell"), false);
});

test("startup rollback after a shell consumer fails never mounts the React root", async () => {
  const activationError = new Error("window shell consumer failed");
  const fixture = createMainFixture({
    additionalPlugins: ({requireSdk}) => {
      const {windowShellKey} = requireSdk("@lodestory/sdk/window-shell");
      return [{
        id: "test.failed-shell-consumer",
        requires: [windowShellKey],
        provides: [],
        activate(context) {
          assert.equal(typeof context.get(windowShellKey).View, "function");
          throw activationError;
        },
        deactivate() {},
      }];
    },
  });
  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.rootElement.children[0]?.className, "app-startup-error");
  const core = fixture.createdCores.at(-1);
  assert.equal(core.isMounted("window-shell"), false);
  assert.equal(core.isMounted("navigation-layout"), false);
  assert.equal(core.isMounted("workbench"), false);
  assert.equal(core.isMounted("test.failed-shell-consumer"), false);
});
