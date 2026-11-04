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

function getSettings(fixture) {
  return fixture.getService(fixture.requireSdk("@lodestory/sdk/settings").settingsKey);
}

function renderRegisteredPage(fixture, ui, id) {
  const tree = fixture.UiPages({ service: ui });
  const pageContainer = tree.props.children.find((page) => page.key === id);
  assert.ok(pageContainer, `page '${id}' should have been visited and registered`);
  const page = pageContainer.props.children;
  return page.type === fixture.components.ErrorBoundary ? page.props.children : page;
}

function renderPageContent(fixture, registeredPage) {
  let content = registeredPage;
  if (content?.type === fixture.components.PageShell) content = content.props.children;
  if (content?.type === fixture.components.NavigationLayout) content = content.props.children;
  if (content?.type === fixture.components.ErrorBoundary) content = content.props.children;
  return content;
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

function settingsStore(fixture) {
  const SettingsDialog = fixture.loadModule("plugins/settings/SettingsDialog.tsx").SettingsDialog;
  const dialog = findElement(fixture.roots[0].tree, SettingsDialog);
  assert.ok(dialog, "settings shell is installed in the existing UI root");
  return dialog.props.store;
}

function temporaryPagePlugin(uiKey) {
  let remove;
  return {
    id: "test.temporary-page", requires: [uiKey], provides: [],
    activate(context) { remove = context.get(uiKey).registerPage({id: "test.temporary-page", render: () => null}); },
    deactivate() { remove?.(); },
  };
}

function project(id, name, path) {
  return { id, name, path, lastOpenedAt: "2026-10-12T08:00:00.000Z" };
}

async function waitForWorkbench(workbench) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = workbench.getSnapshot();
    if (!snapshot.busy || snapshot.loading?.error) {
      assert.equal(snapshot.loading?.error?.message, undefined, snapshot.loading?.error?.message);
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("workbench startup did not settle");
}

async function openWorkbenchProject(workbench, target) {
  const opened = await workbench.openProject(target);
  if (opened) await waitForWorkbench(workbench);
  return opened;
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

test("shared navigation opens settings without navigating away from welcome", async () => {
  const fixture = await startFixture();
  const ui = getUi(fixture);

  assert.equal(ui.getSnapshot().current.id, "welcome");
  const welcomeShell = renderRegisteredPage(fixture, ui, "welcome");
  assert.equal(welcomeShell.type, fixture.components.PageShell);
  const welcomeLayout = welcomeShell.props.children;
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

  const store = settingsStore(fixture);
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().selectedId, "appearance.theme");
  assert.equal(ui.getSnapshot().current.id, "welcome");
  store.close();
  assert.equal(store.getSnapshot().open, false);

  const snapshot = ui.getSnapshot();
  assert.deepEqual({ ...snapshot.current }, { id: "welcome", params: undefined });
  assert.deepEqual(Array.from(snapshot.pages, ({ id, active }) => ({ id, active })), [
    { id: "welcome", active: true },
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
  await waitForWorkbench(workbench);
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

  assert.equal(getSettings(fixture).open(), true);
  assert.equal(ui.getSnapshot().current.id, "editor");
  settingsStore(fixture).close();
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
  await waitForWorkbench(workbench);
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
    additionalPlugins: ({ requireSdk }) => [
      gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate),
      temporaryPagePlugin(requireSdk("@lodestory/sdk/ui").uiKey),
    ],
  });
  const ui = getUi(fixture);
  const workbench = getWorkbench(fixture);
  const firstProject = project("novel-1", "第一本", "/stories/first");
  const secondProject = project("novel-2", "第二本", "/stories/second");

  assert.equal(await ui.openPage("editor", { project: firstProject }), true);
  await waitForWorkbench(workbench);
  const firstSessionId = workbench.getSnapshot().session.id;
  assert.equal(gate.started.length, 1);

  assert.equal(await ui.openPage("test.temporary-page"), false, "direct UI navigation is guarded");
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
  await waitForWorkbench(workbench);
  assert.equal(workbench.getSnapshot().session.id, firstSessionId);
  assert.equal(gate.started.length, 1);
  assert.equal(await ui.openPage("editor", { project: secondProject }), true);
  await waitForWorkbench(workbench);
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
  await waitForWorkbench(workbench);
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
    additionalPlugins: ({ requireSdk }) => [
      gatePlugin(requireSdk("@lodestory/sdk/workbench").workbenchKey, gate),
      temporaryPagePlugin(requireSdk("@lodestory/sdk/ui").uiKey),
    ],
  });
  const ui = getUi(fixture);
  const workbench = getWorkbench(fixture);
  await ui.openPage("editor", { project: project("novel-1", "第一本", "/stories/first") });
  await waitForWorkbench(workbench);

  const navigation = ui.openPage("test.temporary-page");
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
  assert.equal(getSettings(fixture).open(), true);
  await core.unmount("workbench-toolbar");
  await core.unmount("settings");
  assert.equal(core.isMounted("settings"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), ["welcome"],
    "removing the toolbar participant first stops the workbench view");
  assert.equal(fixture.logs.filter((entry) => entry === "root.unmount").length, 1);
  assert.throws(() => ui.openPage("settings"), /mounted page container/);

  await core.unmount("welcome");
  assert.equal(core.isMounted("welcome"), false);
  assert.deepEqual(Array.from(ui.getSnapshot().pages, ({ id }) => id), []);
  assert.equal(core.isMounted("workbench-toolbar"), false);
  await core.unmount("document-search");
  // Release workbench consumers and body-editor implementations before their providers.
  await core.unmount("outline-design");
  await core.unmount("writing-status");
  await core.unmount("timeline");
  await core.unmount("asset-management");
  await core.unmount("markdown-editor");
  await core.unmount("plain-text-editor");
  await core.unmount("rich-text-editor");
  await core.unmount("document-tabs");
  await core.unmount("body-editor");
  assert.equal(core.isMounted("body-editor"), false);
  await core.unmount("project-management");
  assert.equal(core.isMounted("project-management"), false);
  await core.unmount("documents");
  assert.equal(core.isMounted("documents"), false);
  await core.unmount("canvas");
  await core.unmount("project-storage");
  await core.unmount("project-search");
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
  await openWorkbenchProject(workbench, project("novel-1", "第一本", "/stories/first"));

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
  await waitForWorkbench(workbench);
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
  assert.ok(fixture.tauriCalls.some(({command, args}) => command === "create_project_file" && args.path === "第二章.md"));
  assert.equal(projectModel.getSnapshot().activeDocumentPath, "第二章.md");
});

test("a failed document save blocks project close and keeps the draft available for retry", async () => {
  let failWrites = true;
  const fixture = await startFixture({
    invokeHandler(command, args) {
      if (command === "list_documents") return [];
      if (command === "list_project_directory") return {exists: false, entries: [], issues: []};
      if (command === "read_project_file") return {path: args.path, fileName: args.path.split("/").at(-1), bytes: Array.from(new TextEncoder().encode("原文"))};
      if (command === "save_project_file") {
        if (failWrites) throw new Error("磁盘写入失败");
        return undefined;
      }
      if (command === "create_project_file") return {path: args.path, fileName: args.path.split("/").at(-1), bytes: args.bytes};
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  const workbench = getWorkbench(fixture);
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  const documents = fixture.getService(fixture.requireSdk("@lodestory/sdk/documents").documentsKey);
  await openWorkbenchProject(workbench, project("novel-save-failure", "保存保护", "/stories/save-failure"));
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
    if (command === "list_project_directory") return {exists: false, entries: [], issues: []};
      if (command === "read_project_file") return {path: args.path, fileName: args.path.split("/").at(-1), bytes: []};
    if (command === "save_project_file") return undefined;
    return undefined;
  }});
  const workbench = getWorkbench(fixture);
  const {documentsKey, documentRevealRequested} = fixture.requireSdk("@lodestory/sdk/documents");
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  await openWorkbenchProject(workbench, project("delayed-reveal", "延迟通知", "/stories/delayed-reveal"));
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
  assert.equal(await openWorkbenchProject(workbench, project("novel-first", "第一本", "/stories/first")), true);
  const firstSessionId = workbench.getSnapshot().session.id;
  const firstWorkspace = documents.getWorkspace(firstSessionId);
  assert.ok(firstWorkspace);
  const created = await firstWorkspace.create("", "第一章.md");
  assert.ok(created);

  assert.equal(await openWorkbenchProject(workbench, project("novel-second", "第二本", "/stories/second")), true);
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
