import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("plain text editor registers only TXT and loads its own component on demand", async () => {
  function PlainTextStub() {}
  const fixture = createMainFixture({moduleMocks: {
    "plugins/plain-text-editor/PlainTextEditor.tsx": {default: PlainTextStub},
  }});
  const {bodyEditorKey} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const {createPlainTextEditorPlugin} = fixture.loadModule("plugins/plain-text-editor/plainTextEditorPlugin.ts");

  const definitions = new Map();
  const removed = [];
  const service = {registerEditor(definition) {
    definitions.set(definition.id, definition);
    return () => { removed.push(definition.id); definitions.delete(definition.id); };
  }};
  const plugin = createPlainTextEditorPlugin();
  assert.equal(plugin.id, "plain-text-editor");
  assert.deepEqual(Array.from(plugin.requires), [bodyEditorKey]);
  plugin.activate({track: value => value, get(key) { assert.strictEqual(key, bodyEditorKey); return service; }});

  const definition = definitions.get("plain-text");
  assert.ok(definition);
  assert.deepEqual(Array.from(definition.formats), ["plain-text"]);
  assert.deepEqual(Array.from(definition.replaces, replacement => ({id: replacement.id, format: replacement.format})),
    [{id: "quill", format: "plain-text"}]);
  assert.equal(definition.getText("\uFEFFa\r\nb", "plain-text"), "\uFEFFa\r\nb");
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier === "./PlainTextEditor"), false,
    "registering TXT support does not load the editor component");
  const loaded = await definition.load();
  assert.strictEqual(loaded.default, PlainTextStub);

  plugin.deactivate();
  plugin.deactivate();
  assert.deepEqual(removed, ["plain-text"]);
});
