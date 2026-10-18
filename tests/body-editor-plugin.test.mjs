import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function createWorkspace() {
  let snapshot = {documents: [], activeId: null, blocked: false};
  const listeners = new Set();
  return {
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setSnapshot(next) {
      snapshot = {...snapshot, ...next};
      for (const listener of [...listeners]) listener();
    },
  };
}

function setup({rejectContentId} = {}) {
  const fixture = createMainFixture();
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const {documentsKey, documentCreateRequested, documentRevealRequested} = fixture.requireSdk("@lodestory/sdk/documents");
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {bodyEditorKey} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const session = {id: "session-one", project: {id: "project-one", name: "第一本", path: "/stories/one"}};
  let workbenchSnapshot = {session, active: true, busy: false};
  const workbenchListeners = new Set();
  const workspaces = new Map([[session.id, createWorkspace()]]);
  const contributions = [];
  const wrappers = [];
  const provided = new Map();
  const events = new Map();
  const emitted = [];
  const shown = [];
  const removedEvents = [];
  let participant;
  const participations = [];
  const workbench = {
    getSnapshot() { return workbenchSnapshot; },
    subscribe(listener) { workbenchListeners.add(listener); return () => workbenchListeners.delete(listener); },
    registerParticipant(value) {
      participant = value;
      return async () => {
        for (const current of participations.splice(0).reverse()) await current?.dispose?.();
      };
    },
  };
  const documents = {getWorkspace(id) { return workspaces.get(id) ?? null; }};
  const layout = {
    registerContent(content) {
      if (content.id === rejectContentId) throw new Error(`duplicate ${content.id}`);
      contributions.push(content);
      return () => { contributions.splice(contributions.indexOf(content), 1); };
    },
    show(id) { shown.push(id); },
  };
  const ui = {
    addWrapper(wrapper) {
      wrappers.push(wrapper);
      return () => {
        const index = wrappers.indexOf(wrapper);
        if (index >= 0) wrappers.splice(index, 1);
      };
    },
  };
  const context = {
    get(key) {
      if (key === workbenchKey) return workbench;
      if (key === documentsKey) return documents;
      if (key === layoutKey) return layout;
      if (key === uiKey) return ui;
      throw new Error(`Unexpected service '${key.id}'.`);
    },
    provide(key, service) {
      if (provided.has(key)) throw new Error(`Service '${key.id}' already provided.`);
      provided.set(key, service);
    },
    on(key, listener) {
      if (!events.has(key)) events.set(key, new Set());
      events.get(key).add(listener);
      return () => { events.get(key)?.delete(listener); removedEvents.push(key); };
    },
    async emit(key, payload) {
      emitted.push({key, payload});
      await Promise.all([...(events.get(key) ?? [])].map(listener => listener(payload)));
    },
  };
  const plugin = fixture.loadModule("plugins/body-editor/bodyEditorPlugin.tsx").createBodyEditorPlugin();

  return {
    context,
    contributions,
    bodyEditorKey,
    documentCreateRequested,
    documentRevealRequested,
    emitted,
    events,
    fixture,
    layout,
    plugin,
    prepareWrappers: async () => { await Promise.all(wrappers.map(({prepare}) => prepare())); },
    provided,
    participant: () => participant,
    participations,
    removedEvents,
    session,
    shown,
    wrappers,
    start(sessionValue = session) {
      const current = participant.start(sessionValue);
      participations.push(current);
      return current;
    },
    workspace: workspaces.get(session.id),
    workspaces,
    setWorkbench(next) {
      workbenchSnapshot = {...workbenchSnapshot, ...next};
      for (const listener of [...workbenchListeners]) listener();
    },
  };
}

function renderModel(f, id) {
  const main = f.contributions.find(({id: contentId}) => contentId === "body-editor.main");
  assert.ok(main, "the body editor main content should be registered");
  const provider = main.render({active: true});
  assert.equal(provider.type, f.fixture.components.BodyEditorContentProvider);
  provider.type(provider.props);
  const model = f.fixture.bodyEditorModels.get(id);
  assert.ok(model, "the content provider should resolve this session's body editor model");
  return model;
}

function resolveEditor(f, id, format) {
  const resolve = f.fixture.bodyEditorResolvers.get(id);
  assert.equal(typeof resolve, "function", "the body editor content provider exposes the session's format resolver");
  return resolve(format);
}

test("body editor declares the SDK contract and keeps reveal listening before a document is active", async () => {
  const f = setup();
  const {workbenchKey} = f.fixture.requireSdk("@lodestory/sdk/workbench");
  const {documentsKey} = f.fixture.requireSdk("@lodestory/sdk/documents");
  const {layoutKey} = f.fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = f.fixture.requireSdk("@lodestory/sdk/ui");
  assert.equal(f.plugin.id, "body-editor");
  assert.deepEqual(Array.from(f.plugin.requires, key => key.id), [workbenchKey.id, documentsKey.id, layoutKey.id, uiKey.id]);
  assert.deepEqual(Array.from(f.plugin.provides, key => key.id), [f.bodyEditorKey.id]);

  f.plugin.activate(f.context);
  await f.prepareWrappers();
  assert.equal(typeof f.provided.get(f.bodyEditorKey).registerEditor, "function");
  assert.equal(f.events.get(f.documentRevealRequested).size, 1, "the reveal handler exists before any project session starts");
  assert.deepEqual(Array.from(f.contributions, ({id, role}) => ({id, role})), [
    {id: "body-editor.main", role: "main"},
  ]);

  await f.context.emit(f.documentRevealRequested, {sessionId: f.session.id, documentId: "not-open-yet"});
  assert.deepEqual(f.shown, [], "a reveal received without a session model is safely ignored");
  f.start();
  const model = renderModel(f, f.session.id);
  assert.equal(resolveEditor(f, f.session.id, "markdown").id, "textarea");
  assert.equal(resolveEditor(f, f.session.id, "plain-text").id, "textarea");
  assert.equal(resolveEditor(f, f.session.id, "rich-delta"), undefined);
  assert.equal(typeof (await resolveEditor(f, f.session.id, "markdown").load()).default, "function");
  assert.deepEqual({projectName: model.getSnapshot().projectName, projectPath: model.getSnapshot().projectPath}, {
    projectName: f.session.project.name,
    projectPath: f.session.project.path,
  });

  await f.plugin.deactivate();
  assert.equal(f.contributions.length, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.events.get(f.documentRevealRequested).size, 0);
  assert.equal(f.participations.length, 0);
});

test("body editor models are session-scoped and valid reveal restores hidden content during busy or blocked state", async () => {
  const f = setup();
  f.plugin.activate(f.context);
  await f.prepareWrappers();
  const firstModel = (f.start(), renderModel(f, f.session.id));
  const firstWorkspace = f.workspace;
  assert.strictEqual(firstModel.getSnapshot().workspace, firstWorkspace,
    "the body editor model exposes the documents service workspace for its own session");
  const activeDocument = {id: "opaque-id-1", path: "第一章.md", content: "正文"};
  firstWorkspace.setSnapshot({documents: [activeDocument], activeId: activeDocument.id, blocked: true});
  let changes = 0;
  const unsubscribe = firstModel.subscribe(() => changes++);
  f.setWorkbench({active: false, busy: true});

  await f.context.emit(f.documentRevealRequested, {sessionId: "old-session", documentId: activeDocument.id});
  await f.context.emit(f.documentRevealRequested, {sessionId: f.session.id, documentId: "late-id"});
  assert.equal(firstModel.getSnapshot().revealVersion, 0);
  assert.deepEqual(f.shown, []);

  await f.context.emit(f.documentRevealRequested, {sessionId: f.session.id, documentId: activeDocument.id});
  assert.deepEqual(f.shown, ["body-editor.main"]);
  assert.equal(firstModel.getSnapshot().revealVersion, 1);
  assert.equal(changes, 1, "a reveal update lets the mounted editor retry focus when it becomes interactive");

  const secondSession = {id: "session-two", project: {id: "project-two", name: "第二本", path: "/stories/two"}};
  const secondWorkspace = createWorkspace();
  f.workspaces.set(secondSession.id, secondWorkspace);
  const secondDocument = {id: "opaque-id-2", path: "第二章.md", content: "新正文"};
  secondWorkspace.setSnapshot({documents: [secondDocument], activeId: secondDocument.id});
  f.setWorkbench({session: secondSession, active: true, busy: false});
  f.start(secondSession);
  const secondModel = renderModel(f, secondSession.id);
  assert.notStrictEqual(firstModel.getSnapshot().workspace, secondModel.getSnapshot().workspace);
  assert.equal(secondModel.getSnapshot().revealVersion, 0);

  await f.context.emit(f.documentRevealRequested, {sessionId: f.session.id, documentId: activeDocument.id});
  assert.equal(firstModel.getSnapshot().revealVersion, 1, "a delayed reveal from a previous session cannot change its model");
  assert.equal(secondModel.getSnapshot().revealVersion, 0);

  unsubscribe();
  await f.plugin.deactivate();
  assert.equal(firstModel.revealDocument(activeDocument.id), false, "deactivation disposes every session model");
  assert.equal(secondModel.revealDocument(secondDocument.id), false);
});

test("new-document requests follow session, visibility, busy, blocked, and SDK event guards", async () => {
  const f = setup();
  f.plugin.activate(f.context);
  await f.prepareWrappers();
  f.start();
  const model = renderModel(f, f.session.id);

  model.requestNewDocument("chapters");
  await flushStartup();
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].key.id, f.documentCreateRequested.id);
  assert.equal(f.emitted[0].payload.sessionId, f.session.id);
  assert.equal(f.emitted[0].payload.parentPath, "chapters");

  f.setWorkbench({active: false});
  model.requestNewDocument();
  f.setWorkbench({active: true, busy: true});
  model.requestNewDocument();
  f.setWorkbench({busy: false});
  f.workspace.setSnapshot({blocked: true});
  model.requestNewDocument();
  f.setWorkbench({session: {id: "different-session", project: {id: "other", name: "另一本", path: "/other"}}});
  model.requestNewDocument();
  await flushStartup();
  assert.equal(f.emitted.length, 1, "invalid or stale requests never reach project management");

  await f.plugin.deactivate();
});

test("partial contribution failure rolls back its listener, participant, and earlier content", async () => {
  const f = setup({rejectContentId: "body-editor.main"});
  assert.throws(() => f.plugin.activate(f.context), /duplicate body-editor.main/);
  await f.plugin.deactivate();
  assert.equal(f.contributions.length, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.events.get(f.documentRevealRequested).size, 0);
  assert.equal(f.removedEvents.length, 1);
});

