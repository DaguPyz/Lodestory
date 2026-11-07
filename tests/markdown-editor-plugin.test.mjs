import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createBodyEditorService() {
  const definitions = new Map();
  const revoked = [];
  return {
    definitions,
    revoked,
    registerEditor(definition) {
      definitions.set(definition.id, definition);
      return () => {
        revoked.push(definition.id);
        definitions.delete(definition.id);
      };
    },
  };
}

function createContext(bodyEditorKey, bodyEditorService) {
  return {
    track: value => value,
    get(key) {
      assert.strictEqual(key, bodyEditorKey);
      return bodyEditorService;
    },
  };
}

test("markdown editor instances own independent registrations and teardown", async () => {
  const fixture = createMainFixture();
  const {bodyEditorKey} = fixture.requireSdk("@lodestory/sdk/body-editor");
  const {createMarkdownEditorPlugin} = fixture.loadModule("plugins/markdown-editor/markdownEditorPlugin.ts");
  const serviceA = createBodyEditorService();
  const serviceB = createBodyEditorService();
  const pluginA = createMarkdownEditorPlugin();
  const pluginB = createMarkdownEditorPlugin();

  assert.notStrictEqual(pluginA, pluginB);
  assert.equal(pluginA.id, "markdown-editor");
  assert.deepEqual(Array.from(pluginA.requires, key => key.id), [bodyEditorKey.id]);
  assert.deepEqual(Array.from(pluginA.provides), []);

  pluginA.activate(createContext(bodyEditorKey, serviceA));
  pluginB.activate(createContext(bodyEditorKey, serviceB));
  assert.equal(serviceA.definitions.size, 1);
  assert.equal(serviceB.definitions.size, 1);
  for (const service of [serviceA, serviceB]) {
    const definition = service.definitions.get("milkdown");
    assert.ok(definition);
    assert.deepEqual(Array.from(definition.formats), ["markdown"]);
    assert.equal(typeof definition.load, "function");
  }
  assert.equal(fixture.moduleImports.some(({specifier}) => specifier.startsWith("@milkdown/")), false,
    "registering the lazy editor does not import Milkdown packages");

  await pluginA.deactivate();
  assert.deepEqual(serviceA.revoked, ["milkdown"]);
  assert.equal(serviceA.definitions.has("milkdown"), false);
  assert.equal(serviceB.definitions.has("milkdown"), true,
    "stopping one plugin instance leaves the other instance's registration available");
  assert.equal(typeof serviceB.definitions.get("milkdown").load, "function");

  await pluginA.deactivate();
  assert.deepEqual(serviceA.revoked, ["milkdown"], "repeated deactivation does not revoke twice");
  assert.deepEqual(serviceB.revoked, [], "deactivating A never revokes B");

  await pluginB.deactivate();
  assert.deepEqual(serviceB.revoked, ["milkdown"]);
  assert.equal(serviceB.definitions.has("milkdown"), false);
});
