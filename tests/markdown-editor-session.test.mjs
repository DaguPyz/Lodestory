import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createSession(driver, initial, callbacks = {}) {
  const fixture = createMainFixture();
  const {createMarkdownEditorSession} = fixture.loadModule("plugins/markdown-editor/createMarkdownEditorSession.ts");
  const events = {changes: [], ready: [], errors: []};
  const session = createMarkdownEditorSession(driver, initial, {
    onChange: content => events.changes.push(content),
    onReady: handle => events.ready.push(handle),
    onError: error => events.errors.push(error),
    ...callbacks,
  });
  return {events, session};
}

function createDriver(initialContent = "") {
  let text = initialContent;
  let listener;
  const calls = {create: 0, destroy: 0, replace: [], readOnly: [], focus: 0};
  return {
    calls,
    create() { calls.create++; return Promise.resolve({}); },
    destroy() { calls.destroy++; return Promise.resolve(); },
    getMarkdown() { return text; },
    replaceMarkdown(content) {
      calls.replace.push(content);
      text = content;
      listener?.(content);
    },
    setReadOnly(value) { calls.readOnly.push(value); },
    focus() { calls.focus++; },
    listen(nextListener) { listener = nextListener; },
    emit(content) { text = content; listener?.(content); },
  };
}

test("session initializes without writing back and preserves local edits across echoes and view-state updates", async () => {
  const driver = createDriver("seed");
  const initial = {content: "seed", readOnly: false, active: true};
  const {events, session} = createSession(driver, initial);

  await Promise.all([session.start(), session.start()]);
  assert.equal(driver.calls.create, 1, "start is idempotent");
  assert.deepEqual(events.changes, [], "loading initial Markdown never becomes a user edit");
  const initialReplacementCount = driver.calls.replace.length;

  session.update({...initial, active: false});
  driver.emit("inactive edit");
  session.update({...initial, active: true});
  driver.emit("draft");
  assert.deepEqual(events.changes, ["draft"]);

  session.update({...initial, readOnly: true});
  assert.equal(driver.calls.replace.length, initialReplacementCount,
    "changing readonly state before the content echo does not roll back a local edit");
  assert.equal(driver.calls.readOnly[driver.calls.readOnly.length - 1], true);
  driver.emit("readonly edit");
  assert.deepEqual(events.changes, ["draft"]);

  session.update({...initial, content: "draft", readOnly: true});
  assert.equal(driver.calls.replace.length, initialReplacementCount, "echoing the editor's own content does not replace its document");
  session.update({...initial, content: "draft", readOnly: false});
  assert.equal(driver.calls.replace.length, initialReplacementCount);

  session.update({content: "server update", readOnly: false, active: true});
  assert.deepEqual(driver.calls.replace.slice(initialReplacementCount), ["server update"]);
  assert.deepEqual(events.changes, ["draft"], "programmatic replacement is not written back as another edit");

  await session.dispose();
});

test("parser normalization after create does not rewrite or mark the original document changed", async () => {
  const driver = createDriver("original text\n");
  driver.create = () => {
    driver.calls.create++;
    driver.emit("original text\n");
    return Promise.resolve({});
  };
  const {events, session} = createSession(driver, {content: "original text", readOnly: false, active: true});

  await session.start();

  assert.equal(driver.getMarkdown(), "original text\n");
  assert.deepEqual(events.changes, [], "a serializer-added trailing newline is not a user edit");
  assert.deepEqual(driver.calls.replace, [], "initial parser normalization does not replace the source content");
  await session.dispose();
});

test("inactive and readonly sessions ignore editor events while active writable sessions report complete content", async () => {
  const driver = createDriver("first");
  const initial = {content: "first", readOnly: true, active: true};
  const {events, session} = createSession(driver, initial);
  await session.start();

  driver.emit("blocked by readonly");
  session.update({...initial, readOnly: false, active: false});
  driver.emit("blocked while inactive");
  session.update({...initial, readOnly: false, active: true});
  driver.emit("complete Markdown document");

  assert.deepEqual(events.changes, ["complete Markdown document"]);
  assert.equal(driver.calls.readOnly[driver.calls.readOnly.length - 1], false);
  await session.dispose();
});

test("dispose invalidates callbacks immediately and waits for an in-flight create before destroying the driver", async () => {
  let finishCreate;
  const createFinished = new Promise(resolve => { finishCreate = resolve; });
  const driver = createDriver("initial");
  driver.create = () => {
    driver.calls.create++;
    return createFinished;
  };
  const {events, session} = createSession(driver, {content: "initial", readOnly: false, active: true});

  const starting = session.start();
  const disposing = session.dispose();
  assert.deepEqual(events.ready, [], "dispose before readiness never publishes a focus handle");
  assert.equal(driver.calls.destroy, 0, "destroy waits until create settles");
  driver.emit("late change");
  finishCreate({});
  await Promise.all([starting, disposing, session.dispose()]);
  driver.emit("after dispose");

  assert.equal(driver.calls.create, 1);
  assert.equal(driver.calls.destroy, 1);
  assert.deepEqual(events.changes, []);
  assert.deepEqual(events.ready, []);
});

test("dispose clears a published focus handle exactly once", async () => {
  const driver = createDriver("ready text");
  const {events, session} = createSession(driver, {content: "ready text", readOnly: false, active: true});

  await session.start();
  const handle = events.ready[0];
  assert.equal(typeof handle?.focus, "function");
  handle.focus();
  assert.equal(driver.calls.focus, 1);

  await Promise.all([session.dispose(), session.dispose()]);
  assert.deepEqual(events.ready, [handle, null]);
  handle.focus();
  assert.equal(driver.calls.focus, 1, "a disposed focus handle is inert");
  assert.equal(driver.calls.destroy, 1, "repeated dispose calls destroy the driver once");
});

test("an external content update during create is applied after creation without being echoed", async () => {
  let finishCreate;
  const createFinished = new Promise(resolve => { finishCreate = resolve; });
  const driver = createDriver("initial");
  driver.create = () => {
    driver.calls.create++;
    return createFinished;
  };
  const initial = {content: "initial", readOnly: false, active: true};
  const {events, session} = createSession(driver, initial);

  const starting = session.start();
  session.update({...initial, content: "external during create"});
  assert.deepEqual(driver.calls.replace, [], "content replacement waits until the editor has finished creating");
  finishCreate({});
  await starting;

  assert.equal(driver.calls.replace[driver.calls.replace.length - 1], "external during create");
  assert.deepEqual(events.changes, [], "the queued external update is not reported as a user edit");
  await session.dispose();
});

test("create failures are reported once without rejecting start", async () => {
  const driver = createDriver();
  const failure = new Error("Milkdown failed to create");
  driver.create = () => { driver.calls.create++; return Promise.reject(failure); };
  const {events, session} = createSession(driver, {content: "seed", readOnly: false, active: true});

  await Promise.all([session.start(), session.start()]);
  assert.deepEqual(events.errors, [failure]);
  assert.deepEqual(events.changes, []);
  await session.dispose();
});
