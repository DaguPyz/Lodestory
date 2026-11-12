import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("body editor extracts and searches TXT source while rejecting unsupported extensions", async () => {
  const fixture = createMainFixture();
  const {createBodyEditorRegistry, getEditorFormat} = fixture.loadModule("plugins/body-editor/bodyEditorRegistry.ts");
  const registry = createBodyEditorRegistry({"plain-text": "text"}, () => {});
  const changes = [];
  const unsubscribe = registry.service.subscribe(() => changes.push("changed"));
  registry.service.registerEditor({
    id: "text",
    formats: ["plain-text"],
    async load() { return {default: function Editor() { return null; }}; },
  });
  registry.start();

  assert.equal(getEditorFormat("chapter.txt"), "plain-text");
  for (const fileName of ["chapter.md", "chapter.markdown", "chapter.lode", "chapter.csv"]) {
    assert.equal(getEditorFormat(fileName), undefined, `${fileName} is not an app document format`);
    assert.equal(registry.service.getText(fileName, "unsupported"), undefined);
    assert.equal(await registry.service.getSearchText(fileName, "unsupported"), undefined);
  }
  assert.equal(registry.service.getText("chapter.txt", "\uFEFFA\r\nB"), "\uFEFFA\r\nB");
  assert.equal(await registry.service.getSearchText("chapter.txt", "plain source: {}"), "plain source: {}");
  assert.equal(changes.length, 1, "editor registration notifies the status subscriber");

  unsubscribe();
  registry.dispose();
  assert.equal(changes.length, 1, "an unsubscribed listener is not called during cleanup");
});
