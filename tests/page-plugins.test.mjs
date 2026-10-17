import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, deferred, flushStartup } from "./helpers/mainStartupFixture.mjs";

function getUi(fixture) {
  const uiKey = fixture.requireSdk("@lodestory/sdk/ui").uiKey;
  return fixture.getService(uiKey);
}

function getWorkbench(fixture) {
  const workbenchKey = fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey;
  return fixture.getService(workbenchKey);
}

function renderRegisteredPage(fixture, ui, id) {
  const tree = fixture.UiPages({ service: ui });
  const pageContainer = tree.props.children.find((page) => page.key === id);
  assert.ok(pageContainer, `page '${id}' should have been visited and registered`);
  const page = pageContainer.props.children;
  return page.type === fixture.components.ErrorBoundary ? page.props.children : page;
}

function renderEditor(fixture, ui) {
  const shell = renderRegisteredPage(fixture, ui, "editor");
  assert.equal(shell.type, fixture.components.PageShell);
  assert.equal(shell.props.showBrowserTitlebar, false);
  assert.equal(shell.props.children.type, fixture.components.WorkbenchPage);
  return shell.props.children;
}

function renderWorkbenchView(fixture, editorPage) {
  return fixture.components.WorkbenchPage(editorPage.props);
}

function project(id, name, path) {
  return { id, name, path, lastOpenedAt: "2026-10-12T08:00:00.000Z" };
}

function gatePlugin(workbenchKey, gate) {
  return {
    id: "test-workbench-gate",
    requires: [workbenchKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      gate.remove = workbench.registerParticipant({
        id: "test-workbench-gate",
        start(session) {
          gate.started.push(session.id);
          return {
            beforeLeave(reason) {
              gate.reasons.push(reason);
              if (gate.check) return gate.check(reason);
              return gate.allowed;
            },
            dispose() {
              gate.disposed.push(session.id);
              if (gate.disposeError) throw gate.disposeError;
            },
          };
        },
      });
    },
    async deactivate() { await gate.remove?.(); },
  };
}

async function startFixture(options = {}) {
  const fixture = createMainFixture(options);
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
  await welcome.props.onOpenSettings();

  assert.equal(ui.getSnapshot().current.id, "settings");
  const settings = renderRegisteredPage(fixture, ui, "settings");
  assert.equal(settings.type, fixture.components.ThemeSettingsPage);
  await settings.props.onBack();

  const snapshot = ui.getSnapshot();
  assert.deepEqual({ ...snapshot.current }, { id: "welcome", params: undefined });
  assert.deepEqual(Array.from(snapshot.pages, ({ id, active }) => ({ id, active })), [
    { id: "welcome", active: true },
    { id: "settings", active: false },
  ]);
  assert.equal(fixture.rootCalls.length, 1, "page navigation should stay in the existing root");
});

test("workbench retains a project across settings and gives each reopened project a new session", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);
  const workbench = getWorkbench(fixture);
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  const firstProject = project("novel-1", "第一本", "/stories/first");

  const welcome = renderRegisteredPage(fixture, ui, "welcome");
  assert.equal(await welcome.props.onOpenProject(firstProject), true);
  let editor = renderEditor(fixture, ui);
  const firstSessionId = workbench.getSnapshot().session.id;
  let view = renderWorkbenchView(fixture, editor);
  assert.equal(view.type, layout.View);
  assert.equal(view.key, firstSessionId);
  assert.equal(view.props.active, true);
  assert.deepEqual({ ...ui.getSnapshot().current.params.project }, {
    id: firstProject.id,
    name: firstProject.name,
    path: firstProject.path,
  });

  await ui.openPage("settings");
  await ui.back();
  editor = renderEditor(fixture, ui);
  assert.equal(workbench.getSnapshot().session.id, firstSessionId, "temporary navigation should retain the same project session");
  assert.equal(renderWorkbenchView(fixture, editor).key, firstSessionId);

  assert.equal(await workbench.closeProject(), true);
  assert.equal(ui.getSnapshot().current.id, "welcome");
  assert.equal(workbench.getSnapshot().session, null);
  assert.equal(ui.getSnapshot().canGoBack, false, "closing a project clears consumed navigation history");
  await ui.back();
  assert.equal(workbench.getSnapshot().session, null, "back cannot reopen a closed project");
  const welcomeAgain = renderRegisteredPage(fixture, ui, "welcome");
  assert.equal(await welcomeAgain.props.onOpenProject(firstProject), true);
  editor = renderEditor(fixture, ui);
  const reopenedSessionId = workbench.getSnapshot().session.id;
  assert.notEqual(reopenedSessionId, firstSessionId, "reopening the same project must create a fresh session");
  assert.equal(renderWorkbenchView(fixture, editor).key, reopenedSessionId);
  assert.equal(fixture.rootCalls.length, 1, "navigation must not create another React root");
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 0);
});

test("direct navigation, back, and same-page project switching all honor workbench leave checks", async () => {
  const gate = { allowed: false, started: [], reasons: [], disposed: [] };
  const fixture = await startFixture({
    additionalPlugins: ({ requireSdk }) => [gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate)],
  });
  const ui = getUi(fixture);
  const workbench = getWorkbench(fixture);
  const firstProject = project("novel-1", "第一本", "/stories/first");
  const secondProject = project("novel-2", "第二本", "/stories/second");

  assert.equal(await ui.openPage("editor", { project: firstProject }), true);
  const firstSessionId = workbench.getSnapshot().session.id;
  assert.equal(gate.started.length, 1);

  assert.equal(await ui.openPage("settings"), false, "direct UI navigation is guarded");
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(workbench.getSnapshot().session.id, firstSessionId);
  assert.equal(await ui.back(), false, "back navigation is guarded");
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(await ui.openPage("editor", { project: secondProject }), false, "same-page project changes are guarded");
  assert.equal(ui.getSnapshot().current.params.project.path, firstProject.path);
  assert.equal(workbench.getSnapshot().session.id, firstSessionId);
  assert.deepEqual(gate.reasons, ["suspend", "close", "switch"]);

  gate.allowed = true;
  assert.equal(await ui.openPage("editor", { project: firstProject }), true, "reopening the current project reuses its session");
  assert.equal(workbench.getSnapshot().session.id, firstSessionId);
  assert.equal(gate.started.length, 1);
  assert.equal(await ui.openPage("editor", { project: secondProject }), true);
  const secondSessionId = workbench.getSnapshot().session.id;
  assert.notEqual(secondSessionId, firstSessionId);
  assert.equal(gate.started.length, 2);
  assert.deepEqual(gate.disposed, [firstSessionId]);
  assert.equal(workbench.getSnapshot().session.project.path, secondProject.path);
  assert.equal(ui.getSnapshot().current.id, "editor");
});

test("normal window close uses the same asynchronous leave checks and preserves the project on rejection", async () => {
  const gate = { allowed: false, started: [], reasons: [], disposed: [] };
  const fixture = await startFixture({
    additionalPlugins: ({ requireSdk }) => [gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate)],
  });
  const workbench = getWorkbench(fixture);
  const activeProject = project("novel-1", "第一本", "/stories/first");
  assert.equal(fixture.closeRequestListeners.size, 1, "the workbench should install a native close listener");
  assert.equal(await workbench.openProject(activeProject), true);
  const sessionId = workbench.getSnapshot().session.id;

  const rejected = await fixture.requestWindowClose();
  assert.equal(rejected.prevented, true);
  assert.equal(workbench.getSnapshot().session.id, sessionId);
  assert.equal(workbench.getSnapshot().busy, false);
  assert.deepEqual(gate.reasons, ["shutdown"]);

  gate.allowed = true;
  const closed = await fixture.requestWindowClose();
  assert.equal(closed.prevented, false);
  assert.equal(workbench.getSnapshot().session, null);
  assert.deepEqual(gate.disposed, [sessionId]);
});

test("navigation waits for an asynchronous participant decision before committing the route", async () => {
  const decision = deferred();
  const gate = { allowed: true, check: () => decision.promise, started: [], reasons: [], disposed: [] };
  const fixture = await startFixture({
    additionalPlugins: ({ requireSdk }) => [gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate)],
  });
  const ui = getUi(fixture);
  const workbench = getWorkbench(fixture);
  await ui.openPage("editor", { project: project("novel-1", "第一本", "/stories/first") });

  const navigation = ui.openPage("settings");
  assert.equal(workbench.getSnapshot().busy, true, "the workbench should lock edits while leave approval is pending");
  assert.equal(ui.getSnapshot().current.id, "editor", "the route must remain unchanged until the guard resolves");
  decision.resolve(false);
  assert.equal(await navigation, false);
  assert.equal(workbench.getSnapshot().busy, false);
  assert.equal(ui.getSnapshot().current.id, "editor");
});

test("page plugins revoke their route contributions and the UI root unmounts only once", async () => {
  const fixture = await startFixture();
  const core = fixture.createdCores.at(-1);
  const uiKey = fixture.requireSdk("@lodestory/sdk/ui").uiKey;
  const ui = core.get(uiKey);

  await ui.openPage("editor", { project: project("novel-1", "第一本", "/stories/first") });
  await ui.openPage("settings");
  await core.unmount("settings");
  assert.equal(core.isMounted("settings"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), ["welcome", "editor"]);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.throws(() => ui.openPage("settings"), /mounted page container/);

  await core.unmount("welcome");
  assert.equal(core.isMounted("welcome"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), ["editor"]);
  await core.unmount("editor-features");
  assert.equal(core.isMounted("editor-features"), false);
  await core.unmount("workbench");
  assert.equal(core.isMounted("workbench"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages), []);
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);

  await core.unmountAll();
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.throws(() => ui.openPage("welcome"), /UI service is no longer active/);
  assert.throws(() => ui.back(), /UI service is no longer active/);
  assert.throws(() => ui.getSnapshot(), /UI service is no longer active/);
  assert.throws(() => core.get(uiKey), /Service 'app\/ui' is not registered/);
});

test("the workbench rejects direct editor navigation without a complete project record", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);

  await assert.rejects(ui.openPage("editor"), /project with an id, name, and path/);
  assert.equal(ui.getSnapshot().current.id, "welcome");
  assert.equal(getWorkbench(fixture).getSnapshot().session, null);
});


test("a cleanup failure after an approved native close does not leave an unmounted window open", async () => {
  const gate = {
    allowed: true, started: [], reasons: [], disposed: [],
    disposeError: new Error("participant cleanup failed"),
  };
  const fixture = await startFixture({
    additionalPlugins: ({ requireSdk }) => [gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate)],
  });
  const workbench = getWorkbench(fixture);
  await workbench.openProject(project("novel-1", "第一本", "/stories/first"));

  const closed = await fixture.requestWindowClose();
  assert.equal(closed.prevented, false, "save approval has already committed the close");
  assert.equal(workbench.getSnapshot().session, null);
  assert.equal(gate.disposed.length, 1);
  assert.ok(fixture.logs.some(entry => entry?.level === "error" && entry.args[0] === "Workbench could not close the application."));
});
