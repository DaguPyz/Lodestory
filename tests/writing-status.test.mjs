import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function textContent(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node.props ? textContent(node.props.children) : "";
}

test("writing status counts extracted plain text and shows a placeholder when extraction is unavailable", () => {
  const fixture = createMainFixture();
  const {EditorStatusBar} = fixture.loadModule("plugins/writing-status/EditorStatusBar.tsx");
  const document = {saveState: "saved", content: '{"format":"quill-delta","ops":[{"insert":"not the visible count"}] }'};

  const malformed = textContent(EditorStatusBar({document, text: undefined}));
  assert.match(malformed, /文稿 —/);
  assert.doesNotMatch(malformed, /字/);

  const extracted = textContent(EditorStatusBar({document, text: "A\n猫"}));
  assert.match(extracted, /文稿 2 字/);
  assert.doesNotMatch(extracted, /not the visible count/);

  const hiddenStatus = EditorStatusBar({document, text: "A\n猫", showDocumentDetails: false});
  assert.equal(hiddenStatus.props["data-document-details-hidden"], true);
  const hiddenDocument = textContent(hiddenStatus);
  assert.doesNotMatch(hiddenDocument, /已保存|文稿|字/);
  assert.match(hiddenDocument, /100%/);
});

test("writing status follows the public body main visibility and preserves the percentage display", () => {
  const fixture = createMainFixture();
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const {documentsKey} = fixture.requireSdk("@lodestory/sdk/documents");
  const {bodyEditorKey, bodyEditorContentIds} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const session = {id: "status-session", project: {id: "status-project", name: "正文", path: "/stories/status"}};
  const workbench = {getSnapshot: () => ({session}), subscribe: () => () => {}};
  const workspace = {getSnapshot: () => ({documents: [], activeId: null}), subscribe: () => () => {}};
  const documents = {getWorkspace: id => id === session.id ? workspace : null};
  const bodyEditor = {getText: () => undefined, subscribe: () => () => {}};
  let layoutSnapshot = {contents: [], shownIds: [bodyEditorContentIds.main]};
  const layout = {
    registerContent(value) { this.content = value; return () => { this.content = undefined; }; },
    getSnapshot: () => layoutSnapshot,
    subscribe: () => () => {},
  };
  const services = new Map([[workbenchKey, workbench], [documentsKey, documents], [bodyEditorKey, bodyEditor], [layoutKey, layout]]);
  const plugin = fixture.loadModule("plugins/writing-status/writingStatusPlugin.tsx").createWritingStatusPlugin();
  plugin.activate({get: key => services.get(key)});

  function visibilityProp() {
    const contentElement = layout.content.render({active: true});
    const workspaceElement = contentElement.type(contentElement.props);
    return workspaceElement.props.showDocumentDetails;
  }

  const {EditorStatusBar} = fixture.loadModule("plugins/writing-status/EditorStatusBar.tsx");
  const document = {saveState: "saved", content: "正文"};
  const visibleText = textContent(EditorStatusBar({document, text: "正文", showDocumentDetails: visibilityProp()}));
  assert.match(visibleText, /已保存/);
  assert.match(visibleText, /文稿 2 字/);

  layoutSnapshot = {contents: [], shownIds: []};
  const canvasText = textContent(EditorStatusBar({document, text: "正文", showDocumentDetails: visibilityProp()}));
  assert.doesNotMatch(canvasText, /已保存|文稿|字/);
  assert.match(canvasText, /100%/);

  layoutSnapshot = {contents: [], shownIds: [bodyEditorContentIds.main]};
  const restoredText = textContent(EditorStatusBar({document, text: "正文", showDocumentDetails: visibilityProp()}));
  assert.match(restoredText, /已保存/);
  assert.match(restoredText, /文稿 2 字/);
  plugin.deactivate();
});
