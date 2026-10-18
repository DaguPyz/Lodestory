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
});
