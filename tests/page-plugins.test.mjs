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

function renderPageContent(fixture, registeredPage) {
  const content = registeredPage.type === fixture.components.NavigationLayout
    ? registeredPage.props.children
    : registeredPage;
  return content?.type === fixture.components.ErrorBoundary ? content.props.children : content;
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

function renderBodyEditorModel(fixture, layout, sessionId) {
  const main = layout.getSnapshot().contents.find(({id}) => id === "body-editor.main");
  assert.ok(main, "the body editor main contribution should be registered");
  const provider = main.render({active: true});
  assert.equal(provider.type, fixture.components.BodyEditorContentProvider);
  provider.type(provider.props);
  const model = fixture.bodyEditorModels.get(sessionId);
  assert.ok(model, "the body editor model should be connected to the active document workspace");
  return model;
}

function renderProjectManagementModel(fixture, layout, sessionId) {
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "project-management.files");
  assert.ok(navigation, "the project management plugin should register its own navigation content");
  const element = navigation.render({active: true});
  assert.equal(element.type, fixture.components.ProjectFiles);
  const view = element.type(element.props);
  const model = view.props.model ?? fixture.projectManagementModels.get(sessionId);
  assert.ok(model, "the project files view should be connected to this workbench session");
  return model;
}

function findElement(value, expectedType) {
  if (!value || typeof value !== "object") return undefined;
  if (value.type === expectedType) return value;
  const children = value.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findElement(child, expectedType);
    if (match) return match;
  }
  return undefined;
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

test("shared navigation opens settings and settings back returns to welcome", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);

  assert.equal(ui.getSnapshot().current.id, "welcome");
  const welcomeLayout = renderRegisteredPage(fixture, ui, "welcome");
  assert.equal(welcomeLayout.type, fixture.components.NavigationLayout);
  assert.equal(welcomeLayout.props.pageId, "welcome");
  assert.deepEqual(Array.from(welcomeLayout.props.items, ({id, label, group}) => ({id, label, group})), [
    {id: "welcome", label: "作品", group: "primary"},
    {id: "settings", label: "设置", group: "secondary"},
  ]);
  const welcome = renderPageContent(fixture, welcomeLayout);
  assert.equal(welcome.type, fixture.components.WelcomePage);
  assert.equal("onOpenSettings" in welcome.props, false, "the welcome page owns no application navigation");
  assert.equal(await welcomeLayout.props.onNavigate("settings"), true);

  assert.equal(ui.getSnapshot().current.id, "settings");
  const settingsLayout = renderRegisteredPage(fixture, ui, "settings");
  assert.equal(settingsLayout.type, fixture.components.NavigationLayout);
  assert.equal(settingsLayout.props.pageId, "settings");
  const settings = renderPageContent(fixture, settingsLayout);
  assert.equal(settings.type, fixture.components.ThemeSettingsPage);
  const themeKey = fixture.requireSdk("@lodestory/sdk/theme").themeKey;
  assert.strictEqual(settings.props.service, fixture.getService(themeKey));
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

  const welcome = renderPageContent(fixture, renderRegisteredPage(fixture, ui, "welcome"));
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
  const welcomeAgain = renderPageContent(fixture, renderRegisteredPage(fixture, ui, "welcome"));
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
  await core.unmount("workbench-toolbar");
  assert.equal(core.isMounted("workbench-toolbar"), false);
  await core.unmount("body-editor");
  assert.equal(core.isMounted("body-editor"), false);
  await core.unmount("project-management");
  assert.equal(core.isMounted("project-management"), false);
  await core.unmount("documents");
  assert.equal(core.isMounted("documents"), false);
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

test("project file UI and the independent dialog wrapper connect through the SDK to document workspaces", async () => {
  let sender;
  const fixture = await startFixture({additionalPlugins: () => [{
    id: "project-management-event-sender", requires: [], provides: [],
    activate(context) { sender = context; },
  }]});
  const workbench = getWorkbench(fixture);
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  const documents = fixture.getService(fixture.requireSdk("@lodestory/sdk/documents").documentsKey);
  const activeProject = project("novel-documents", "文档集成", "/stories/documents");
  assert.equal(await workbench.openProject(activeProject), true);
  await flushStartup();
  const sessionId = workbench.getSnapshot().session.id;
  const workspace = documents.getWorkspace(sessionId);
  assert.ok(workspace);
  const projectModel = renderProjectManagementModel(fixture, layout, sessionId);

  layout.hide("project-management.files");
  layout.hide("body-editor.main");
  assert.ok(!layout.getSnapshot().shownIds.includes("project-management.files"));
  assert.ok(!layout.getSnapshot().shownIds.includes("body-editor.main"));
  const {documentCreateRequested} = fixture.requireSdk("@lodestory/sdk/documents");
  await sender.emit(documentCreateRequested, {sessionId});
  await flushStartup();
  assert.equal(projectModel.getSnapshot().dialogOpen, true, "the request should open the project-owned dialog while both layout contents are hidden");

  const dialogElement = findElement(fixture.roots[0].tree, fixture.components.ProjectDialogs);
  assert.ok(dialogElement, "the dialog provider should be mounted by the UI wrapper, outside the navigation content");
  const dialogView = dialogElement.type(dialogElement.props);
  assert.equal(dialogView.props.open, true);
  assert.equal(dialogView.props.model, projectModel);

  await projectModel.create("", "第二章.md");
  await flushStartup();
  const snapshot = workspace.getSnapshot();
  assert.equal(snapshot.documents.length, 1);
  assert.ok(snapshot.documents.some(document => document.path === "第二章.md"));
  assert.equal(snapshot.activeId, encodeURIComponent("第二章.md"));
  assert.ok(layout.getSnapshot().shownIds.includes("body-editor.main"), "creating a document should reveal the body editor main content");
  assert.ok(fixture.tauriCalls.some(({command, args}) => command === "create_document" && args.parentPath === "" && args.name === "第二章.md"));
  assert.equal(projectModel.getSnapshot().activeDocumentPath, "第二章.md");
});

test("a failed document save blocks project close and keeps the draft available for retry", async () => {
  let failWrites = true;
  const fixture = await startFixture({
    invokeHandler(command, args) {
      if (command === "list_documents") return [];
      if (command === "read_document") return {path: args.path, fileName: args.path.split("/").at(-1), content: "原文"};
      if (command === "save_document") {
        if (failWrites) throw new Error("磁盘写入失败");
        return undefined;
      }
      if (command === "create_document") return {path: [args.parentPath, args.name].filter(Boolean).join("/"), fileName: args.name, content: ""};
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  const workbench = getWorkbench(fixture);
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  const documents = fixture.getService(fixture.requireSdk("@lodestory/sdk/documents").documentsKey);
  await workbench.openProject(project("novel-save-failure", "保存保护", "/stories/save-failure"));
  await flushStartup();
  const sessionId = workbench.getSnapshot().session.id;
  const workspace = documents.getWorkspace(sessionId);
  assert.ok(workspace);
  assert.equal(await workspace.open("第一章.md"), true);
  await flushStartup();
  const document = workspace.getSnapshot().documents[0];
  assert.equal(workspace.update(document.id, "未保存的修改"), true);

  assert.equal(await workbench.closeProject(), false);
  await flushStartup();
  assert.equal(workbench.getSnapshot().session.id, sessionId, "the project session must survive a failed leave check");
  assert.equal(workspace.getSnapshot().documents[0].content, "未保存的修改");
  assert.equal(workspace.getSnapshot().documents[0].saveError, "磁盘写入失败");
  assert.ok(layout.getSnapshot().shownIds.includes("body-editor.main"), "the failed document should be revealed for recovery");
  assert.ok(renderBodyEditorModel(fixture, layout, sessionId).getSnapshot().revealVersion > 0,
    "a rejected leave check still notifies the editor to restore focus after recovery");

  failWrites = false;
  assert.equal(await workbench.closeProject(), true);
  assert.equal(documents.getWorkspace(sessionId), null);
});

test("a delayed document reveal request cannot replace a newer selection or its creation directory", async () => {
  let sender;
  const fixture = await startFixture({additionalPlugins: () => [{
    id: "document-event-sender", requires: [], provides: [],
    activate(context) { sender = context; },
  }], invokeHandler(command, args) {
    if (command === "list_documents") return [
      {path: "old", name: "old", children: [{path: "old/第一章.md", name: "第一章.md"}]},
      {path: "current", name: "current", children: [{path: "current/第二章.md", name: "第二章.md"}]},
    ];
    if (command === "read_document") return {path: args.path, fileName: args.path.split("/").at(-1), content: ""};
    if (command === "save_document") return undefined;
    return undefined;
  }});
  const workbench = getWorkbench(fixture);
  const {documentsKey, documentRevealRequested} = fixture.requireSdk("@lodestory/sdk/documents");
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  await workbench.openProject(project("delayed-reveal", "延迟通知", "/stories/delayed-reveal"));
  await flushStartup();
  const sessionId = workbench.getSnapshot().session.id;
  const workspace = fixture.getService(documentsKey).getWorkspace(sessionId);
  await workspace.open("old/第一章.md");
  const oldId = workspace.getSnapshot().activeId;
  await workspace.open("current/第二章.md");
  const currentId = workspace.getSnapshot().activeId;
  await flushStartup();
  const model = renderProjectManagementModel(fixture, layout, sessionId);
  assert.equal(model.getSnapshot().selectedFolder, "current");
  layout.hide("body-editor.main");
  layout.hide("project-management.files");

  await sender.emit(documentRevealRequested, {sessionId, documentId: oldId});

  assert.equal(workspace.getSnapshot().activeId, currentId);
  assert.equal(model.getSnapshot().selectedFolder, "current");
  assert.equal(model.getSnapshot().activeDocumentPath, "current/第二章.md");
  assert.ok(!layout.getSnapshot().shownIds.includes("body-editor.main"));
});

test("project switching releases the old document handle and starts an isolated workspace", async () => {
  const fixture = await startFixture();
  const workbench = getWorkbench(fixture);
  const documents = fixture.getService(fixture.requireSdk("@lodestory/sdk/documents").documentsKey);
  assert.equal(await workbench.openProject(project("novel-first", "第一本", "/stories/first")), true);
  const firstSessionId = workbench.getSnapshot().session.id;
  const firstWorkspace = documents.getWorkspace(firstSessionId);
  assert.ok(firstWorkspace);
  const created = await firstWorkspace.create("", "第一章.md");
  assert.ok(created);

  assert.equal(await workbench.openProject(project("novel-second", "第二本", "/stories/second")), true);
  const secondSessionId = workbench.getSnapshot().session.id;
  const secondWorkspace = documents.getWorkspace(secondSessionId);
  assert.ok(secondWorkspace);
  assert.notEqual(secondWorkspace, firstWorkspace);
  assert.equal(documents.getWorkspace(firstSessionId), null);
  assert.equal(firstWorkspace.getSnapshot().documents.length, 0);
  assert.equal(firstWorkspace.getSnapshot().blocked, true);
  assert.equal(firstWorkspace.update(created.id, "旧会话修改"), false);
  assert.equal(secondWorkspace.getSnapshot().documents.length, 0);
});
