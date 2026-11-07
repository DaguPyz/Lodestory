import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("document tabs follow the public body content visibility and restore the open workspace", () => {
  const fixture = createMainFixture();
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {documentsKey} = fixture.requireSdk("@lodestory/sdk/documents");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const {bodyEditorContentIds} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const {shortcutsKey, shortcutCommandIds, shortcutScopeIds} = fixture.requireSdk("@lodestory/sdk/shortcuts");
  const session = {id: "session-tabs", project: {id: "project-tabs", name: "正文标签", path: "/stories/tabs"}};
  const workbenchSnapshot = {session, active: true, busy: false};
  const workbench = {
    getSnapshot: () => workbenchSnapshot,
    subscribe: () => () => {},
  };
  const document = {id: "chapter.md", path: "chapter.md", fileName: "chapter.md", content: "章节正文", dirty: false, saveState: "saved", saveError: null};
  const workspaceSnapshot = {documents: [document], activeId: document.id, blocked: false, creating: false};
  const workspace = {
    getSnapshot: () => workspaceSnapshot,
    subscribe: () => () => {},
    select() {}, close() {}, closeMany() {}, save() {},
  };
  const documents = {getWorkspace: id => id === session.id ? workspace : null};
  const listeners = new Set();
  let layoutSnapshot = Object.freeze({contents: Object.freeze([]), shownIds: Object.freeze([bodyEditorContentIds.main])});
  let registered;
  const layout = {
    registerContent(content) { registered = content; return () => { registered = undefined; }; },
    getSnapshot: () => layoutSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    hide(id) {
      layoutSnapshot = Object.freeze({...layoutSnapshot, shownIds: Object.freeze(layoutSnapshot.shownIds.filter(current => current !== id))});
      for (const listener of [...listeners]) listener();
    },
    show(id) {
      layoutSnapshot = Object.freeze({...layoutSnapshot, shownIds: Object.freeze([...layoutSnapshot.shownIds, id])});
      for (const listener of [...listeners]) listener();
    },
  };
  const registeredScopes = new Map();
  const shortcuts = {
    registerScope(scope) {
      registeredScopes.set(scope.id, scope);
      return () => { if (registeredScopes.get(scope.id) === scope) registeredScopes.delete(scope.id); };
    },
    subscribe: () => () => {},
    getSnapshot: () => ({commands: [{id: shortcutCommandIds.closeDocument}, {id: shortcutCommandIds.newDocument}], bindings: [], conflicts: []}),
    getShortcut: id => id === shortcutCommandIds.closeDocument ? "⌘ W" : id === shortcutCommandIds.newDocument ? "⌘ N" : undefined,
    execute: async () => true,
  };
  const services = new Map([[layoutKey, layout], [documentsKey, documents], [workbenchKey, workbench], [shortcutsKey, shortcuts]]);
  const plugin = fixture.loadModule("plugins/document-tabs/documentTabsPlugin.tsx").createDocumentTabsPlugin();
  plugin.activate({get: key => services.get(key), track: value => value, emit: async () => {}});
  assert.equal(bodyEditorContentIds.main, "body-editor.main");
  assert.equal(registeredScopes.get(shortcutScopeIds.document).parentId, shortcutScopeIds.workbench);
  assert.equal(registeredScopes.get(shortcutScopeIds.document).active(), true, "the document scope activates only for a usable open document");

  const tabs = registered;
  assert.ok(tabs);
  const contentElement = tabs.render({active: true});
  function renderTabs() {
    const sessionElement = contentElement.type(contentElement.props);
    assert.equal(typeof sessionElement.type, "function");
    return sessionElement.type(sessionElement.props);
  }

  const visible = renderTabs();
  assert.equal(visible.type, fixture.components.DocumentTabs);
  assert.equal(visible.props.documents.length, 1);
  assert.equal(visible.props.closeShortcut, "⌘ W", "the active tab receives the current platform label");
  assert.equal(visible.props.newShortcut, "⌘ N", "the new-document command receives the current platform label");
  const activeId = workspace.getSnapshot().activeId;

  layout.hide(bodyEditorContentIds.main);
  assert.equal(registeredScopes.get(shortcutScopeIds.document).active(), false, "hiding the body removes the close-document scope");
  assert.equal(renderTabs(), null, "hiding the body editor removes the document tabs UI");
  assert.equal(workspaceSnapshot.documents.length, 1, "hiding the body editor keeps its open document");
  assert.equal(workspaceSnapshot.activeId, activeId, "hiding the body editor keeps the active document");

  layout.show(bodyEditorContentIds.main);
  const restored = renderTabs();
  assert.equal(restored.type, fixture.components.DocumentTabs, "showing the body editor restores the tabs UI");
  assert.equal(restored.props.documents.length, 1);
  assert.equal(restored.props.activeDocument, activeId);
  plugin.deactivate();
  assert.equal(registeredScopes.has(shortcutScopeIds.document), false, "deactivation removes the dynamic scope");
});
