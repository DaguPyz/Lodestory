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

test("writing status character counting matches the former Unicode and whitespace semantics", () => {
  const fixture = createMainFixture();
  const {countDocumentCharacters} = fixture.loadModule("plugins/writing-status/countDocumentCharacters.ts");
  const whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const examples = [
    "",
    "A\n猫😀",
    "\ud83d\ude00x\ud83d\udc31",
    "\ud83d \ude00",
    "\ud83d\n\ud83d \ude00",
    "\ud800x\udc00",
    "\u0085\u200b\u180e",
    `A${whitespace}猫😀\nZ`,
  ];
  for (const value of examples) {
    assert.equal(countDocumentCharacters(value), Array.from(value.replace(/\s/g, "")).length, JSON.stringify(value));
  }
  assert.equal(countDocumentCharacters("猫😀 \n".repeat(50_000)), 100_000);
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
  plugin.activate({get: key => services.get(key), track: contribution => contribution});

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
