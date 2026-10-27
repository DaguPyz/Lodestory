import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createRegistry(defaults = {}, beforeRemove = () => {}) {
  const fixture = createMainFixture();
  const {createBodyEditorRegistry} = fixture.loadModule("plugins/body-editor/bodyEditorRegistry.ts");
  return createBodyEditorRegistry(defaults, beforeRemove);
}

function definition(id, formats, load = async () => ({default: function Editor() {}})) {
  return {id, formats, load};
}

test("replacement declarations cannot choose between implementations by registration order", () => {
  const registry = createRegistry({"plain-text": "former-editor"});
  const replacement = {id: "former-editor", format: "plain-text"};
  const first = {...definition("new-text", ["plain-text"]), replaces: [replacement]};
  registry.service.registerEditor(first);
  assert.throws(() => registry.service.registerEditor({
    ...definition("another-text", ["plain-text"]), replaces: [replacement],
  }), /already registered/);
  assert.throws(() => registry.service.registerEditor({
    ...definition("markdown-only", ["markdown"]), replaces: [{id: "other", format: "plain-text"}],
  }), /supported formats/);
  registry.start();
  assert.equal(registry.resolve("plain-text").id, "new-text");
});

test("body editor registry validates registrations and routes only through explicit defaults", () => {
  const registry = createRegistry({markdown: "markdown-editor", "plain-text": "missing-editor"});

  assert.throws(() => registry.service.registerEditor(definition("  ", ["markdown"])));
  assert.throws(() => registry.service.registerEditor(definition("empty-formats", [])));
  assert.throws(() => registry.service.registerEditor(definition("unknown-format", ["html"])));
  assert.throws(() => registry.service.registerEditor(definition("duplicate-format", ["markdown", "markdown"])));
  assert.throws(() => registry.service.registerEditor({id: "missing-loader", formats: ["markdown"]}));

  const removeMarkdown = registry.service.registerEditor(definition("markdown-editor", ["markdown"]));
  assert.throws(() => registry.service.registerEditor(definition("markdown-editor", ["markdown"])));
  registry.service.registerEditor(definition("another-markdown-editor", ["markdown"]));
  registry.service.registerEditor(definition("plain-editor", ["plain-text"]));

  assert.throws(() => registry.resolve("markdown"), undefined, "definitions are not resolvable before startup");
  registry.start();
  registry.start();
  assert.equal(registry.resolve("markdown").id, "markdown-editor");
  assert.equal(registry.resolve("plain-text"), undefined, "a missing configured implementation does not select a different plugin by load order");
  assert.equal(registry.resolve("rich-delta"), undefined, "an unconfigured format has no fallback implementation");
  assert.throws(() => registry.service.registerEditor(definition("late-editor", ["markdown"])), undefined);

  removeMarkdown();
  assert.equal(registry.resolve("markdown"), undefined);
  registry.dispose();
});

test("format plugins contribute conversions that the host can discover by source format", () => {
  const registry = createRegistry({"plain-text": "plain-text"});
  const conversion = {
    id: "convert-to-rich-text", label: "转换为富文本文档", from: "plain-text", extension: "lode",
    convert: content => JSON.stringify({format: "rich", text: content}),
  };
  registry.service.registerEditor({...definition("plain-text", ["plain-text"])});
  registry.service.registerEditor({...definition("rich", ["rich-delta"]), conversions: [conversion]});
  registry.start();

  const conversions = registry.getConversions("plain-text");
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].key, "rich:convert-to-rich-text");
  assert.equal(conversions[0].extension, "lode");
  assert.deepEqual(JSON.parse(conversions[0].convert("全文\n")), {format: "rich", text: "全文\n"});
  assert.deepEqual(Array.from(registry.getConversions("markdown")), [], "converters are selected by their declared source format");
  registry.dispose();

  const invalid = createRegistry();
  assert.throws(() => invalid.service.registerEditor({...definition("bad", ["rich-delta"]), conversions: [
    {...conversion, extension: "../lode"},
  ]}), /conversions/);
  invalid.dispose();
});

test("a format replacement transparently routes legacy mappings without affecting other formats", () => {
  const registry = createRegistry({"plain-text": "quill", "rich-delta": "quill", markdown: "missing"});
  registry.service.registerEditor({...definition("plain-text", ["plain-text"]),
    replaces: [{id: "quill", format: "plain-text"}],
    getText: content => content,
  });
  registry.service.registerEditor(definition("quill", ["rich-delta"]));
  registry.start();

  assert.equal(registry.resolve("plain-text").id, "plain-text");
  assert.equal(registry.resolve("rich-delta").id, "quill");
  assert.equal(registry.resolve("markdown"), undefined, "unrelated unavailable mappings are preserved");
  assert.equal(registry.service.getText("chapter.txt", "\uFEFFA\r\nB"), "\uFEFFA\r\nB");
  assert.equal(registry.service.getText("chapter.lode", "opaque"), undefined,
    "replacement is scoped to its declared format");
  registry.dispose();
});

test("stale and repeated removers are idempotent, and started removal clears the UI first", () => {
  const removals = [];
  let registry;
  let routeDuringCleanup;
  registry = createRegistry({markdown: "same-id"}, () => {
    routeDuringCleanup = registry.resolve("markdown")?.id;
    removals.push("ui");
  });
  const oldRemove = registry.service.registerEditor(definition("same-id", ["markdown"]));
  oldRemove();
  const currentRemove = registry.service.registerEditor(definition("same-id", ["markdown"]));
  oldRemove();

  registry.start();
  assert.equal(registry.resolve("markdown").id, "same-id", "an old revoker cannot unregister a later registration with the same ID");
  currentRemove();
  currentRemove();
  assert.deepEqual(removals, ["ui"], "the UI cleanup runs once before the active definition is removed");
  assert.equal(routeDuringCleanup, "same-id", "the definition remains available while UI cleanup runs");
  assert.equal(registry.resolve("markdown"), undefined);

  const failingCleanup = createRegistry({markdown: "editor"}, () => { throw new Error("cleanup failed"); });
  const remove = failingCleanup.service.registerEditor(definition("editor", ["markdown"]));
  failingCleanup.start();
  assert.throws(remove, /cleanup failed/);
  assert.equal(failingCleanup.resolve("markdown"), undefined, "the definition is removed even when UI cleanup throws");
  failingCleanup.dispose();
});

test("editor loads are shared, cached only while pending, and retry after failure", async () => {
  const registry = createRegistry({markdown: "editor"});
  let attempts = 0;
  registry.service.registerEditor(definition("editor", ["markdown"], async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary load failure");
    return {default: function Editor() {}};
  }));
  registry.start();

  const editor = registry.resolve("markdown");
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
  const registry = createRegistry({markdown: "editor"});
  const remove = registry.service.registerEditor(definition("editor", ["markdown"], () => new Promise(resolve => { finishLoad = resolve; markLoadStarted(); })));
  registry.start();
  const pendingLoad = registry.resolve("markdown").load();
  await loadStarted;
  remove();
  finishLoad({default: function Editor() {}});
  await assert.rejects(pendingLoad);
  registry.dispose();

  let finishDisposedLoad;
  let markDisposedLoadStarted;
  const disposedLoadStarted = new Promise(resolve => { markDisposedLoadStarted = resolve; });
  const disposed = createRegistry({markdown: "editor"});
  disposed.service.registerEditor(definition("editor", ["markdown"], () => new Promise(resolve => { finishDisposedLoad = resolve; markDisposedLoadStarted(); })));
  disposed.start();
  const disposedLoad = disposed.resolve("markdown").load();
  await disposedLoadStarted;
  disposed.dispose();
  finishDisposedLoad({default: function Editor() {}});
  await assert.rejects(disposedLoad);
});

test("invalid editor modules reject and can be retried", async () => {
  let attempts = 0;
  const registry = createRegistry({markdown: "editor"});
  registry.service.registerEditor(definition("editor", ["markdown"], async () => {
    attempts++;
    return attempts === 1 ? {} : {default: function Editor() {}};
  }));
  registry.start();

  const editor = registry.resolve("markdown");
  await assert.rejects(editor.load());
  assert.equal(typeof (await editor.load()).default, "function");
  assert.equal(attempts, 2);
  registry.dispose();
});
