import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createRegistry(defaults = {"plain-text": "editor"}, beforeRemove = () => {}) {
  const fixture = createMainFixture();
  const {createBodyEditorRegistry} = fixture.loadModule("plugins/body-editor/bodyEditorRegistry.ts");
  return createBodyEditorRegistry(defaults, beforeRemove);
}

function definition(id, formats = ["plain-text"], load = async () => ({default: function Editor() {}})) {
  return {id, formats, load};
}

test("body editor registry validates registrations and routes only through explicit defaults", () => {
  const registry = createRegistry({"plain-text": "missing-editor"});

  assert.throws(() => registry.service.registerEditor(definition("  ")));
  assert.throws(() => registry.service.registerEditor(definition("empty-formats", [])));
  assert.throws(() => registry.service.registerEditor(definition("unknown-format", ["html"])));
  assert.throws(() => registry.service.registerEditor(definition("duplicate-format", ["plain-text", "plain-text"])));
  assert.throws(() => registry.service.registerEditor({id: "missing-loader", formats: ["plain-text"]}));

  registry.service.registerEditor(definition("first-editor"));
  registry.service.registerEditor(definition("second-editor"));
  assert.throws(() => registry.resolve("plain-text"), /not ready/);
  registry.start();
  registry.start();
  assert.equal(registry.resolve("plain-text"), undefined,
    "a missing configured implementation does not select another plugin by registration order");
  assert.throws(() => registry.service.registerEditor(definition("late-editor")), /before pluginsReady/);
  registry.dispose();
});

test("editor scroll mode defaults to the document viewport and preserves explicit ownership", () => {
  const documentRegistry = createRegistry();
  documentRegistry.service.registerEditor(definition("editor"));
  assert.throws(() => documentRegistry.service.registerEditor({...definition("invalid-scroll"), scrollMode: "inside-editor"}), /scroll mode/i);
  documentRegistry.start();
  assert.equal(documentRegistry.resolve("plain-text").scrollMode, undefined,
    "omitting the optional setting preserves document scrolling");
  documentRegistry.dispose();

  const editorRegistry = createRegistry({"plain-text": "editor-scroll"});
  editorRegistry.service.registerEditor({...definition("editor-scroll"), scrollMode: "editor"});
  editorRegistry.start();
  assert.equal(editorRegistry.resolve("plain-text").scrollMode, "editor",
    "an editor can own its internal scrolling viewport");
  editorRegistry.dispose();
});

test("stale and repeated removers are idempotent, and started removal clears the UI first", () => {
  const removals = [];
  let registry;
  let routeDuringCleanup;
  registry = createRegistry({"plain-text": "same-id"}, () => {
    routeDuringCleanup = registry.resolve("plain-text")?.id;
    removals.push("ui");
  });
  const oldRemove = registry.service.registerEditor(definition("same-id"));
  oldRemove();
  const currentRemove = registry.service.registerEditor(definition("same-id"));
  oldRemove();

  registry.start();
  assert.equal(registry.resolve("plain-text").id, "same-id",
    "an old revoker cannot unregister a later registration with the same ID");
  currentRemove();
  currentRemove();
  assert.deepEqual(removals, ["ui"], "UI cleanup runs once before the active definition is removed");
  assert.equal(routeDuringCleanup, "same-id", "the definition remains available while UI cleanup runs");
  assert.equal(registry.resolve("plain-text"), undefined);

  const failingCleanup = createRegistry({"plain-text": "editor"}, () => { throw new Error("cleanup failed"); });
  const remove = failingCleanup.service.registerEditor(definition("editor"));
  failingCleanup.start();
  assert.throws(remove, /cleanup failed/);
  assert.equal(failingCleanup.resolve("plain-text").id, "editor", "the definition remains when UI cleanup fails");
  assert.throws(() => failingCleanup.dispose(), /cleanup failed/);
});

test("editor loads are shared, cached only while pending, and retry after failure", async () => {
  const registry = createRegistry();
  let attempts = 0;
  registry.service.registerEditor(definition("editor", ["plain-text"], async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary load failure");
    return {default: function Editor() {}};
  }));
  registry.start();

  const editor = registry.resolve("plain-text");
  const firstAttempt = editor.load();
  assert.strictEqual(editor.load(), firstAttempt, "concurrent consumers share one in-flight load");
  await assert.rejects(firstAttempt, /temporary load failure/);
  const retry = editor.load();
  assert.notStrictEqual(retry, firstAttempt, "a failed load can be retried");
  assert.equal(typeof (await retry).default, "function");
  assert.equal(attempts, 2);
  registry.dispose();
});

test("removing an editor or disposing the registry invalidates late load results", async () => {
  let finishLoad;
  let markLoadStarted;
  const loadStarted = new Promise(resolve => { markLoadStarted = resolve; });
  const registry = createRegistry();
  const remove = registry.service.registerEditor(definition("editor", ["plain-text"], () => new Promise(resolve => {
    finishLoad = resolve;
    markLoadStarted();
  })));
  registry.start();
  const pendingLoad = registry.resolve("plain-text").load();
  await loadStarted;
  remove();
  finishLoad({default: function Editor() {}});
  await assert.rejects(pendingLoad);
  registry.dispose();

  let finishDisposedLoad;
  let markDisposedLoadStarted;
  const disposedLoadStarted = new Promise(resolve => { markDisposedLoadStarted = resolve; });
  const disposed = createRegistry();
  disposed.service.registerEditor(definition("editor", ["plain-text"], () => new Promise(resolve => {
    finishDisposedLoad = resolve;
    markDisposedLoadStarted();
  })));
  disposed.start();
  const disposedLoad = disposed.resolve("plain-text").load();
  await disposedLoadStarted;
  disposed.dispose();
  finishDisposedLoad({default: function Editor() {}});
  await assert.rejects(disposedLoad);
});

test("invalid editor modules reject and can be retried", async () => {
  let attempts = 0;
  const registry = createRegistry();
  registry.service.registerEditor(definition("editor", ["plain-text"], async () => {
    attempts++;
    return attempts === 1 ? {} : {default: function Editor() {}};
  }));
  registry.start();

  const editor = registry.resolve("plain-text");
  await assert.rejects(editor.load());
  assert.equal(typeof (await editor.load()).default, "function");
  assert.equal(attempts, 2);
  registry.dispose();
});
