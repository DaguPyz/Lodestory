import assert from "node:assert/strict";
import test from "node:test";
import {uiPluginFixture} from "./helpers/uiPluginFixture.mjs";

const editorCases = [
  {format: "markdown", fileName: "chapter.md", id: "milkdown"},
  {format: "plain-text", fileName: "chapter.txt", id: "plain-text"},
  {format: "rich-delta", fileName: "chapter.lode", id: "quill"},
];

for (const editorCase of editorCases) {
  for (const withSaveAs of [false, true]) {
    test(`Manuscript renders ${editorCase.format} loading state with onSaveAs ${withSaveAs ? "present" : "omitted"}`, () => {
      const fixture = uiPluginFixture();
      const {Manuscript} = fixture.loadSource("plugins/body-editor/Manuscript.tsx");
      const {ContextMenuProvider} = fixture.loadSource("plugins/context-menu/ContextMenuProvider.tsx");
      let loadCalls = 0;
      const props = {
        document: {
          id: "document-one",
          path: editorCase.fileName,
          fileName: editorCase.fileName,
          content: "正文",
          saveState: "saved",
          saveError: null,
        },
        visible: true,
        active: true,
        format: editorCase.format,
        definition: {
          id: editorCase.id,
          formats: [editorCase.format],
          load: async () => {
            loadCalls++;
            return {default: function TestEditor() { return null; }};
          },
        },
        onChange() {},
        onSave() {},
        onEditorReady() {},
        ...(withSaveAs ? {onSaveAs: async () => {}} : {}),
      };
      const tree = fixture.React.createElement(
        ContextMenuProvider,
        null,
        fixture.React.createElement(Manuscript, props),
      );

      const html = fixture.renderToStaticMarkup(tree);
      assert.match(html, /正在加载编辑器/);
      assert.equal(loadCalls, 0, "server rendering does not execute the editor loader or import its engine");
    });
  }
}
