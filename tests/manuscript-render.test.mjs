import assert from "node:assert/strict";
import test from "node:test";
import {uiPluginFixture} from "./helpers/uiPluginFixture.mjs";

test("Manuscript renders the TXT editor loading state without loading its module", () => {
  const fixture = uiPluginFixture();
  const {Manuscript} = fixture.loadSource("plugins/body-editor/Manuscript.tsx");
  const {ContextMenuProvider} = fixture.loadSource("plugins/context-menu/ContextMenuProvider.tsx");
  let loadCalls = 0;
  const props = {
    document: {
      id: "document-one",
      path: "chapter.txt",
      fileName: "chapter.txt",
      content: "正文",
      saveState: "saved",
      saveError: null,
    },
    visible: true,
    active: true,
    format: "plain-text",
    definition: {
      id: "plain-text",
      formats: ["plain-text"],
      load: async () => {
        loadCalls++;
        return {default: function TestEditor() { return null; }};
      },
    },
    onChange() {},
    onSave() {},
    onEditorReady() {},
  };
  const tree = fixture.React.createElement(
    ContextMenuProvider,
    null,
    fixture.React.createElement(Manuscript, props),
  );

  const html = fixture.renderToStaticMarkup(tree);
  assert.match(html, /正在加载编辑器/);
  assert.equal(loadCalls, 0, "server rendering does not execute the editor loader");
});
