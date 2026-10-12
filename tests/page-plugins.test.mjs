import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, flushStartup } from "./helpers/mainStartupFixture.mjs";

function getUi(fixture) {
  const uiKey = fixture.requireSdk("@lodestory/sdk/ui").uiKey;
  return fixture.getService(uiKey);
}

function renderRegisteredPage(fixture, ui, id) {
  const tree = fixture.UiPages({ service: ui });
  const pageContainer = tree.props.children.find((page) => page.key === id);
  assert.ok(pageContainer, `page '${id}' should have been visited and registered`);
  return pageContainer.props.children;
}

function renderEditor(fixture, ui) {
  const shell = renderRegisteredPage(fixture, ui, "editor");
  assert.equal(shell.type, fixture.components.PageShell);
  assert.equal(shell.props.showBrowserTitlebar, false);
  assert.equal(shell.props.children.type, fixture.components.EditorPage);
  return shell.props.children;
}

function project(id, name, path) {
  return { id, name, path, lastOpenedAt: "2026-10-12T08:00:00.000Z" };
}

async function startFixture() {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.roots.length, 1);
  return fixture;
}

test("welcome opens settings and settings back returns to welcome", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);

  assert.equal(ui.getSnapshot().current.id, "welcome");
  const welcome = renderRegisteredPage(fixture, ui, "welcome");
  assert.equal(welcome.type, fixture.components.WelcomePage);
  welcome.props.onOpenSettings();

  assert.equal(ui.getSnapshot().current.id, "settings");
  const settings = renderRegisteredPage(fixture, ui, "settings");
  assert.equal(settings.type, fixture.components.ThemeSettingsPage);
  settings.props.onBack();

  const snapshot = ui.getSnapshot();
  assert.deepEqual({ ...snapshot.current }, { id: "welcome", params: undefined });
  assert.deepEqual(Array.from(snapshot.pages, ({ id, active }) => ({ id, active })), [
    { id: "welcome", active: true },
    { id: "settings", active: false },
  ]);
  assert.equal(fixture.rootCalls.length, 1, "page navigation should stay in the existing root");
});

test("welcome project navigation restores the editor after settings and creates a new key for another project", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);
  const firstProject = project("novel-1", "第一本", "/stories/first");
  const secondProject = project("novel-2", "第二本", "/stories/second");

  const welcome = renderRegisteredPage(fixture, ui, "welcome");
  welcome.props.onOpenProject(firstProject);
  let editor = renderEditor(fixture, ui);
  const firstKey = editor.key;
  assert.equal(firstKey, "novel-1:/stories/first");
  assert.equal(editor.props.projectName, firstProject.name);
  assert.equal(editor.props.projectPath, firstProject.path);
  assert.equal(editor.props.active, true);
  assert.equal(ui.getSnapshot().current.params.project, firstProject);

  editor.props.onOpenSettings();
  const settings = renderRegisteredPage(fixture, ui, "settings");
  settings.props.onBack();
  editor = renderEditor(fixture, ui);
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(ui.getSnapshot().current.params.project, firstProject);
  assert.equal(editor.key, firstKey, "back should restore the same editor project identity");
  assert.equal(editor.props.active, true);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id, active }) => ({ id, active })), [
    { id: "welcome", active: false },
    { id: "editor", active: true },
    { id: "settings", active: false },
  ]);

  editor.props.onBack();
  assert.equal(ui.getSnapshot().current.id, "welcome");
  assert.equal(ui.getSnapshot().canGoBack, false, "returning from the editor should remove the consumed navigation history");
  ui.back();
  assert.deepEqual({ ...ui.getSnapshot().current }, { id: "welcome", params: undefined }, "back with empty history should be a no-op");
  assert.equal(ui.getSnapshot().canGoBack, false);
  const welcomeAgain = renderRegisteredPage(fixture, ui, "welcome");
  welcomeAgain.props.onOpenProject(secondProject);
  editor = renderEditor(fixture, ui);
  const secondKey = editor.key;
  assert.equal(secondKey, "novel-2:/stories/second");
  assert.notEqual(secondKey, firstKey, "a different project id and path should create a different editor key");

  editor.props.onBack();
  renderRegisteredPage(fixture, ui, "welcome").props.onOpenProject(secondProject);
  editor = renderEditor(fixture, ui);
  assert.equal(editor.key, secondKey, "reopening the same project should keep a stable editor key");
  assert.equal(editor.props.active, true);
  assert.equal(fixture.rootCalls.length, 1, "navigation must not create another React root");
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 0);
});

test("each page plugin revokes its page and the UI root unmounts only once", async () => {
  const fixture = await startFixture();
  const core = fixture.createdCores.at(-1);
  const uiKey = fixture.requireSdk("@lodestory/sdk/ui").uiKey;
  const ui = core.get(uiKey);

  ui.openPage("editor", { project: project("novel-1", "第一本", "/stories/first") });
  ui.openPage("settings");
  await core.unmount("settings");
  assert.equal(core.isMounted("settings"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), ["welcome", "editor"]);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.throws(() => ui.openPage("settings"), /mounted page container/);

  await core.unmount("editor");
  assert.equal(core.isMounted("editor"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), ["welcome"]);
  await core.unmount("welcome");
  assert.equal(core.isMounted("welcome"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages), []);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);

  await core.unmountAll();
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.throws(() => ui.openPage("welcome"), /UI service is no longer active/);
  assert.throws(() => ui.back(), /UI service is no longer active/);
  assert.throws(() => ui.getSnapshot(), /UI service is no longer active/);
  assert.throws(() => core.get(uiKey), /Service 'app\/ui' is not registered/);
});

test("the editor page rejects navigation without a complete project record", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);

  ui.openPage("editor");
  assert.throws(() => renderEditor(fixture, ui), /project with an id, name, and path/);
});
