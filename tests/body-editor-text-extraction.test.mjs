import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("body editor text extraction follows the configured file format and tolerates missing or invalid extractors", () => {
  const fixture = createMainFixture();
  const {createBodyEditorRegistry} = fixture.loadModule("plugins/body-editor/bodyEditorRegistry.ts");
  const registry = createBodyEditorRegistry({markdown: "markdown", "plain-text": "text", "rich-delta": "rich"}, () => {});
  const changes = [];
  const unsubscribe = registry.service.subscribe(() => changes.push("changed"));
  const editor = (id, formats, getText) => ({
    id,
    formats,
    ...(getText ? {getText} : {}),
    async load() { return {default: function Editor() { return null; }}; },
  });

  const removeMarkdown = registry.service.registerEditor(editor("markdown", ["markdown"]));
  const removeText = registry.service.registerEditor(editor("text", ["plain-text"]));
  const removeRich = registry.service.registerEditor(editor("rich", ["rich-delta"], (content, format) => {
    assert.equal(format, "rich-delta");
    if (content === "corrupt") throw new Error("invalid Delta");
    return "visible text";
  }));
  registry.start();

  assert.equal(registry.service.getText("chapter.md", "**raw markdown**"), "**raw markdown**");
  assert.equal(registry.service.getText("chapter.txt", "plain JSON-looking text: {}"), "plain JSON-looking text: {}");
  assert.equal(registry.service.getText("chapter.lode", "valid envelope"), "visible text");
  assert.equal(registry.service.getText("chapter.lode", "corrupt"), undefined);
  assert.equal(registry.service.getText("chapter.csv", "unmapped"), undefined);
  assert.equal(changes.length, 3, "each editor registration notifies the status subscriber");

  removeRich();
  assert.equal(registry.service.getText("chapter.lode", "valid envelope"), undefined);
  assert.equal(changes.length, 4, "revoking the selected editor refreshes subscribers");
  unsubscribe();
  removeMarkdown();
  removeText();
  assert.equal(changes.length, 4, "an unsubscribed listener is not called during cleanup");
  registry.dispose();
});
