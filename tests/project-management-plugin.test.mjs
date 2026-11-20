import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function setup({wrapperError, invokeHandler} = {}) {
  const fixture = createMainFixture({invokeHandler});
  const sdk = specifier => fixture.requireSdk(specifier);
  const {workbenchKey} = sdk("@lodestory/sdk/workbench");
  const {documentsKey, documentCreateRequested, documentRevealRequested} = sdk("@lodestory/sdk/documents");
  const {layoutKey} = sdk("@lodestory/sdk/layout");
  const {i18nKey} = sdk("@lodestory/sdk/i18n");
  const {uiKey} = sdk("@lodestory/sdk/ui");
  const {projectSearchKey} = sdk("@lodestory/sdk/project-search");
  const {shortcutsKey, shortcutCommandIds, shortcutScopeIds} = sdk("@lodestory/sdk/shortcuts");
  const session = {id: "project-session", project: {id: "project", name: "项目", path: "/projects/current"}};
  let workbenchSnapshot = {session, active: true, busy: false};
  const workbenchListeners = new Set();
  const eventListeners = new Map();
  const removedEvents = [];
  const contributions = [];
  const wrappers = [];
  const lifecycle = [];
  const shortcutCommands = new Map();
  const shortcutScopes = new Map();
  const shortcutBindings = new Map();
  const shortcutListeners = new Set();
  const shortcuts = {
    registerCommand(value) { shortcutCommands.set(value.id, value); return () => shortcutCommands.delete(value.id); },
    registerScope(value) { shortcutScopes.set(value.id, value); return () => shortcutScopes.delete(value.id); },
    registerBinding(value) { shortcutBindings.set(value.id, value); return () => shortcutBindings.delete(value.id); },
    async execute(id, args) {
      const command = shortcutCommands.get(id);
      const invocation = {source: "ui", target: null, args};
      if (!command || command.enabled && !command.enabled(invocation)) return false;
      await command.run(invocation);
      return true;
    },
    getShortcut(id) { return [...shortcutBindings.values()].find(binding => binding.commandId === id)?.keys; },
    getSnapshot() { return {commands: [], bindings: [], conflicts: []}; },
    subscribe(listener) { shortcutListeners.add(listener); return () => shortcutListeners.delete(listener); },
    async setBinding() {}, async resetBinding() {},
    async invokeKeyboard(id, args, target = null) {
      const command = shortcutCommands.get(id);
      const invocation = {source: "keyboard", target, args};
      if (!command || command.enabled && !command.enabled(invocation)) return false;
      await command.run(invocation);
      return true;
    },
  };
  let participation;
  let activeParticipation;
  const workspaceListeners = new Set();
  let documentSnapshot = {documents: [], activeId: null, openingPath: null, creating: false, deletingPath: null, blocked: false, error: null};
  const workspace = {
    getSnapshot() { return documentSnapshot; },
    subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
    clearError() {},
    async createDirectory() { throw new Error("Unexpected directory creation in this fixture"); },
    async deleteDocument() { throw new Error("Unexpected document deletion in this fixture"); },
    async open(path) {
      const document = {id: `opaque::${path}`, path, fileName: path.split("/").at(-1), content: "", saveState: "saved", saveError: null};
      documentSnapshot = {...documentSnapshot, documents: [document], activeId: document.id};
      for (const listener of [...workspaceListeners]) listener();
      return true;
    },
    async create(parentPath, name) {
      const path = [parentPath, name].filter(Boolean).join("/");
      const document = {id: `opaque::${path}`, path, fileName: name, content: "", saveState: "saved", saveError: null};
      documentSnapshot = {...documentSnapshot, documents: [...documentSnapshot.documents, document], activeId: document.id, creating: false};
      for (const listener of [...workspaceListeners]) listener();
      return document;
    },
  };
  const workbench = {
    getSnapshot() { return workbenchSnapshot; },
    subscribe(listener) { workbenchListeners.add(listener); return () => workbenchListeners.delete(listener); },
    registerParticipant(value) {
      lifecycle.push("participant.register");
      participation = value;
      return async () => {
        lifecycle.push("participant.remove");
        await (await activeParticipation)?.dispose?.();
        activeParticipation = undefined;
      };
    },
  };
  const documents = {getWorkspace(id) { return id === session.id ? workspace : null; }};
  const layout = {registerContent(value) {
    contributions.push(value);
    lifecycle.push("layout.register");
    return () => { lifecycle.push("layout.remove"); contributions.splice(contributions.indexOf(value), 1); };
  }};
  const ui = {addWrapper(value) {
    lifecycle.push("wrapper.register");
    if (wrapperError) throw wrapperError;
    wrappers.push(value);
    return () => { lifecycle.push("wrapper.remove"); wrappers.splice(wrappers.indexOf(value), 1); };
  }};
  const context = {
    track: value => value,
    provide() {},
    get(key) {
      if (key === workbenchKey) return workbench;
      if (key === documentsKey) return documents;
      if (key === layoutKey) return layout;
      if (key === i18nKey) return undefined;
      if (key === uiKey) return ui;
      if (key === projectSearchKey) return {registerSource() { return () => {}; }};
      if (key === shortcutsKey) return shortcuts;
      throw new Error(`Unexpected service '${key.id}'.`);
    },
    on(key, listener) {
      if (!eventListeners.has(key)) eventListeners.set(key, new Set());
      eventListeners.get(key).add(listener);
      return () => { eventListeners.get(key)?.delete(listener); removedEvents.push(key); };
    },
    async emit(key, payload) {
      await Promise.all([...(eventListeners.get(key) ?? [])].map(listener => listener(payload)));
    },
  };
  const plugin = fixture.loadModule("plugins/project-management/projectManagementPlugin.tsx").createProjectManagementPlugin();

  return {
    context,
    contributions,
    documentCreateRequested,
    documentRevealRequested,
    eventListeners,
    fixture,
    layout,
    lifecycle,
    plugin,
    participation: () => participation,
    startParticipant(value = session) {
      activeParticipation = participation.start(value);
      return activeParticipation;
    },
    removedEvents,
    shortcutBindings,
    shortcutCommandIds,
    shortcutCommands,
    shortcutScopeIds,
    shortcutScopes,
    shortcuts,
    session,
    setWorkbench(next) {
      workbenchSnapshot = {...workbenchSnapshot, ...next};
      for (const listener of [...workbenchListeners]) listener();
    },
    setWorkspace(next) {
      documentSnapshot = {...documentSnapshot, ...next};
      for (const listener of [...workspaceListeners]) listener();
    },
    ui,
    wrappers,
    workspace,
  };
}

function find(value, type) {
  if (!value || typeof value !== "object") return undefined;
  if (value.type === type) return value;
  const children = value.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, type);
    if (found) return found;
  }
  return undefined;
}

test("project management registers its own navigation and a dialog wrapper independent of the hidden content", async () => {
  const f = setup();
  const {workbenchKey} = f.fixture.requireSdk("@lodestory/sdk/workbench");
  const {documentsKey} = f.fixture.requireSdk("@lodestory/sdk/documents");
  const {layoutKey} = f.fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = f.fixture.requireSdk("@lodestory/sdk/ui");
  const {projectSearchKey} = f.fixture.requireSdk("@lodestory/sdk/project-search");
  const {shortcutsKey} = f.fixture.requireSdk("@lodestory/sdk/shortcuts");
  const {i18nKey} = f.fixture.requireSdk("@lodestory/sdk/i18n");
  assert.deepEqual(Array.from(f.plugin.requires, key => key.id),
    [workbenchKey.id, documentsKey.id, layoutKey.id, uiKey.id, projectSearchKey.id, shortcutsKey.id, i18nKey.id]);
  assert.deepEqual(Array.from(f.plugin.provides, key => key.id), ["app/project-document-catalog"]);
  f.plugin.activate(f.context);
  assert.equal(f.contributions.length, 1);
  assert.deepEqual({id: f.contributions[0].id, role: f.contributions[0].role}, {id: "project-management.files", role: "navigation"});
  assert.equal(f.wrappers.length, 1);
  assert.equal(f.wrappers[0].id, "project-management.dialogs");
  assert.equal(f.shortcutBindings.get("project-management.new-document").keys, "Mod+N");
  assert.equal(f.shortcutBindings.get("project-management.new-document").allowInInput, true);
  assert.equal(f.shortcutBindings.get("project-management.rename-entry").keys, "F2");

  await f.startParticipant();
  await flushStartup();
  const navigation = f.contributions[0].render({active: false});
  const filesView = navigation.type(navigation.props);
  assert.equal(filesView.props.active, false);
  assert.equal(filesView.props.model.getSnapshot().sessionId, f.session.id);

  await f.context.emit(f.documentCreateRequested, {sessionId: "old-session"});
  const wrapper = f.wrappers[0].wrap("pages");
  const dialogElement = find(wrapper, f.fixture.components.ProjectDialogs);
  assert.ok(dialogElement, "the dialog provider is mounted beside pages by the root wrapper");
  const dialog = dialogElement.type(dialogElement.props);
  const liveModel = dialog.props.model;
  assert.ok(liveModel);
  assert.equal(liveModel.getSnapshot().dialogOpen, false);

  await f.context.emit(f.documentCreateRequested, {sessionId: f.session.id, parentPath: ""});
  assert.equal(liveModel.getSnapshot().dialogOpen, true);
  assert.equal(liveModel.getSnapshot().selectedFolder, "");
  await f.context.emit(f.documentCreateRequested, {sessionId: "old-session"});
  assert.equal(liveModel.getSnapshot().dialogOpen, true, "a stale session event cannot replace the current dialog state");

  await f.plugin.deactivate();
  assert.equal(f.contributions.length, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.eventListeners.get(f.documentCreateRequested).size, 0);
  assert.equal(f.eventListeners.get(f.documentRevealRequested).size, 0);
  assert.equal(f.shortcutCommands.size, 0);
  assert.equal(f.shortcutBindings.size, 0);
});

test("new-document and rename commands validate sessions, busy operations, and tree target paths", async () => {
  const f = setup({invokeHandler(command) {
    if (command === "list_documents") return [{path: "notes/chapter.txt", name: "chapter.txt"}];
    throw new Error(`Unexpected command '${command}'.`);
  }});
  f.plugin.activate(f.context);
  await f.startParticipant();
  await flushStartup();
  const dialogTree = f.wrappers[0].wrap("pages");
  const dialogElement = find(dialogTree, f.fixture.components.ProjectDialogs);
  assert.ok(dialogElement);
  dialogElement.type(dialogElement.props);
  const model = f.fixture.projectManagementModels.get(f.session.id);

  assert.equal(await f.shortcuts.invokeKeyboard(f.shortcutCommandIds.newDocument, undefined, {tagName: "INPUT"}), true,
    "Mod+N can enter the common command without UI arguments even when an input owns focus");
  assert.equal(model.getSnapshot().dialogOpen, true);
  model.closeCreateDialog();
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.newDocument, {sessionId: "old-session"}), false,
    "a stale new-document request cannot open a dialog in the current session");
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.newDocument, {sessionId: f.session.id, parentPath: "missing"}), false,
    "new-document commands validate that the parent is still a directory");
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.newDocument, {sessionId: f.session.id, extension: "txt"}), false,
    "new-document commands do not accept per-format creation arguments");
  f.setWorkbench({busy: true});
  assert.equal(await f.shortcuts.invokeKeyboard(f.shortcutCommandIds.newDocument, undefined), false,
    "new-document commands stay disabled while the workbench is busy");
  f.setWorkbench({busy: false});

  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.renameEntry, {sessionId: "old-session", path: "notes/chapter.txt"}), false,
    "a late rename action from a previous project is ignored");
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.renameEntry, {sessionId: f.session.id, path: "missing.txt"}), false,
    "rename commands validate that the target still exists");
  f.setWorkspace({openingPath: "notes/chapter.txt"});
  assert.equal(await f.shortcuts.invokeKeyboard(f.shortcutCommandIds.renameEntry,
    {sessionId: f.session.id, path: "notes/chapter.txt"}), true, "F2 accepts rename while that file is still opening");
  assert.equal(model.getSnapshot().renamePath, "notes/chapter.txt");

  await f.plugin.deactivate();
});

test("partial activation failure removes the event listeners, participant, and layout contribution", async () => {
  const f = setup({wrapperError: new Error("duplicate wrapper")});
  assert.throws(() => f.plugin.activate(f.context), /duplicate wrapper/);
  // EngineCore invokes deactivate on this path; invoking it directly verifies the plugin's rollback hook.
  await f.plugin.deactivate();
  assert.equal(f.contributions.length, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.eventListeners.get(f.documentCreateRequested).size, 0);
  assert.equal(f.eventListeners.get(f.documentRevealRequested).size, 0);
  assert.ok(f.lifecycle.includes("participant.remove"));
  assert.ok(f.lifecycle.includes("layout.remove"));
});

test("initial project tree failure rejects participant startup, cleans its model, and allows retry", async () => {
  let listCalls = 0;
  const f = setup({invokeHandler(command) {
    if (command !== "list_documents") throw new Error(`Unexpected command '${command}'.`);
    listCalls += 1;
    if (listCalls === 1) throw {message: "目录读取失败"};
    return [];
  }});
  f.plugin.activate(f.context);

  await assert.rejects(f.startParticipant(), /目录读取失败/);
  assert.equal(listCalls, 1, "startup waits for the initial tree request");
  await f.startParticipant();
  assert.equal(listCalls, 2, "retry creates a fresh tree model and starts a new request");
  await f.plugin.deactivate();
});
