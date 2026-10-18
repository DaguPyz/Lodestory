import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("rich text editor instances register independently and revoke only their own Quill editor", async () => {
  function EditorStub() {}
  const fontLoaders = [];
  const fixture = createMainFixture({
    moduleMocks: {
      "plugins/rich-text-editor/RichTextEditor.tsx": {default: EditorStub},
      "plugins/rich-text-editor/systemFonts.ts": {
        createSystemFontLoader() {
          const loader = async () => ["Arial"];
          fontLoaders.push(loader);
          return loader;
        },
      },
    },
  });
  const {bodyEditorKey} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const format = fixture.loadModule("plugins/rich-text-editor/richDeltaFormat.ts");
  const {createRichTextEditorPlugin} = fixture.loadModule("plugins/rich-text-editor/richTextEditorPlugin.ts");

  function createService() {
    const editors = new Map();
    let revocations = 0;
    return {
      editors,
      revocations: () => revocations,
      service: {
        registerEditor(definition) {
          editors.set(definition.id, definition);
          return () => {
            revocations++;
            editors.delete(definition.id);
          };
        },
      },
    };
  }
  function context(service) {
    return {get(key) {
      if (key === bodyEditorKey) return service;
      assert.fail(`unexpected capability ${key.id}`);
    }};
  }

  const serviceA = createService();
  const serviceB = createService();
  const pluginA = createRichTextEditorPlugin();
  const pluginB = createRichTextEditorPlugin();
  pluginA.activate(context(serviceA.service));
  pluginB.activate(context(serviceB.service));
  assert.equal(fontLoaders.length, 2);
  assert.notStrictEqual(fontLoaders[0], fontLoaders[1], "each rich editor plugin owns its font loader");

  const editorA = serviceA.editors.get("quill");
  const editorB = serviceB.editors.get("quill");
  assert.ok(editorA);
  assert.ok(editorB);
  assert.deepEqual(Array.from(pluginB.requires), [bodyEditorKey]);
  assert.deepEqual(Array.from(editorB.formats), ["plain-text", "rich-delta"]);
  assert.equal(typeof editorB.load, "function");
  assert.equal(typeof editorB.getText, "function");
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier === "quill" || specifier.startsWith("quill/")), false,
    "registering the lazy editor does not import Quill");

  const delta = format.createRichDeltaFromPlainText("第一行\n第二行\n");
  assert.equal(editorB.getText(delta, "rich-delta"), "第一行\n第二行\n");
  assert.equal(editorB.getText("literal JSON-looking text", "plain-text"), "literal JSON-looking text");
  assert.throws(() => editorB.getText("{", "rich-delta"), /Quill 无法读取/);

  const loaded = await editorB.load();
  const props = {
    documentId: "document-1",
    format: "rich-delta",
    content: "",
    readOnly: false,
    active: true,
    onChange() {},
    onReady() {},
    onError() {},
  };
  const wrapped = loaded.default(props);
  assert.strictEqual(wrapped.type, EditorStub);
  assert.strictEqual(wrapped.props.loadFontFamilies, fontLoaders[1],
    "the Quill component receives its plugin's internal font loader");
  assert.equal(wrapped.props.documentId, "document-1");

  await pluginA.deactivate();
  await pluginA.deactivate();
  assert.equal(serviceA.editors.size, 0);
  assert.equal(serviceA.revocations(), 1);
  assert.strictEqual(serviceB.editors.get("quill"), editorB,
    "deactivating one plugin instance leaves the other registry entry usable");
  assert.equal(serviceB.revocations(), 0);

  await pluginB.deactivate();
  assert.equal(serviceB.editors.size, 0);
  assert.equal(serviceB.revocations(), 1);
});
