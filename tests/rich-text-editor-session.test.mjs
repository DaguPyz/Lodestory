import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function loadSession() {
  const fixture = createMainFixture();
  return fixture.loadModule("plugins/rich-text-editor/createRichTextEditorSession.ts").createRichTextEditorSession;
}

function createDriver(initialContent) {
  let content = initialContent;
  let listener;
  const calls = {created: 0, destroyed: 0, replacements: [], readOnly: [], focused: 0};
  return {
    calls,
    create: async () => { calls.created++; },
    destroy: async () => { calls.destroyed++; },
    getContent: () => content,
    replaceContent(next, format) {
      calls.replacements.push({content: next, format});
      content = next;
      listener?.();
    },
    setReadOnly(value) { calls.readOnly.push(value); },
    focus() { calls.focused++; },
    listen(next) { listener = next; },
    publish(next) { content = next; listener?.(); },
  };
}

const state = (content, {active = true, readOnly = false} = {}) => ({
  content,
  format: "rich-delta",
  active,
  readOnly,
});

test("rich text session does not write initialization, skips echoes, and applies external replacements without echoing", async () => {
  const createRichTextEditorSession = loadSession();
  const initial = '{"format":"quill-delta","version":1,"ops":[{"insert":"原文\n"}]}';
  const typed = '{"format":"quill-delta","version":1,"ops":[{"insert":"用户修改\n"}]}';
  const external = '{"format":"quill-delta","version":1,"ops":[{"insert":"外部替换\n"}]}';
  const driver = createDriver(initial);
  const changes = [];
  const ready = [];
  const errors = [];
  const session = createRichTextEditorSession(driver, state(initial), {
    onChange: value => changes.push(value),
    onReady: handle => ready.push(handle),
    onError: error => errors.push(error),
  });

  await session.start();
  assert.deepEqual(changes, [], "loading existing Delta content is not a user edit");
  assert.deepEqual(driver.calls.replacements, []);
  assert.equal(typeof ready[0]?.focus, "function");

  driver.publish(typed);
  assert.deepEqual(changes, [typed], "a user update publishes the complete Delta envelope");
  session.update(state(typed));
  assert.deepEqual(driver.calls.replacements, [], "the host echo does not replace Quill content or its history");

  session.update(state(external));
  assert.deepEqual(driver.calls.replacements, [{content: external, format: "rich-delta"}]);
  assert.deepEqual(changes, [typed], "programmatic replacement does not feed back into persistence");
  assert.deepEqual(errors, []);
  await session.dispose();
});

test("rich text session gates inactive and readonly edits, then clears its handle once on dispose", async () => {
  const createRichTextEditorSession = loadSession();
  const initial = '{"format":"quill-delta","version":1,"ops":[{"insert":"正文\n"}]}';
  const driver = createDriver(initial);
  const changes = [];
  const ready = [];
  const session = createRichTextEditorSession(driver, state(initial, {active: false}), {
    onChange: value => changes.push(value),
    onReady: handle => ready.push(handle),
    onError() {},
  });

  await session.start();
  driver.publish("inactive edit");
  session.update(state(initial, {active: true, readOnly: true}));
  driver.publish("readonly edit");
  session.update(state(initial, {active: true, readOnly: false}));
  driver.publish("active edit");
  assert.deepEqual(changes, ["active edit"]);

  await session.dispose();
  await session.dispose();
  driver.publish("after dispose");
  assert.deepEqual(ready.map(value => value === null ? null : "handle"), ["handle", null]);
  assert.equal(driver.calls.destroyed, 1);
  assert.deepEqual(changes, ["active edit"]);
});

test("an external content change received while Quill is creating is applied after creation without persistence echo", async () => {
  const createRichTextEditorSession = loadSession();
  const initial = '{"format":"quill-delta","version":1,"ops":[{"insert":"原文\n"}]}';
  const external = '{"format":"quill-delta","version":1,"ops":[{"insert":"创建期间更新\n"}]}';
  let finishCreate;
  const driver = createDriver(initial);
  driver.create = () => new Promise(resolve => { finishCreate = resolve; });
  const changes = [];
  const session = createRichTextEditorSession(driver, state(initial), {
    onChange: value => changes.push(value),
    onReady() {},
    onError() {},
  });

  const starting = session.start();
  await Promise.resolve();
  assert.equal(typeof finishCreate, "function", "the driver create call is pending");
  session.update(state(external));
  finishCreate();
  await starting;

  assert.deepEqual(driver.calls.replacements, [{content: external, format: "rich-delta"}]);
  assert.deepEqual(changes, []);
  await session.dispose();
});
