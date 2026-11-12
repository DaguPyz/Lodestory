import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("content flush handles reject reads from replaced or invalidated editors", () => {
  const {createEditorCallbackGuard} = createMainFixture().loadModule("plugins/body-editor/editorCallbackGuard.ts");
  const token = Symbol("editor");
  let current = token;
  let exposed;
  let reads = 0;
  const guard = createEditorCallbackGuard(token, candidate => candidate === current, {
    onChange() {}, onError() {}, onReady(handle) { exposed = handle; },
  });
  guard.onReady({focus() {}, flushContent() { reads++; return "待提交的正文"; }});
  const first = exposed;
  assert.equal(first.flushContent(), "待提交的正文");
  guard.onReady({focus() {}, flushContent() { reads++; return "新的正文"; }});
  assert.throws(() => first.flushContent(), /no longer active/);
  const second = exposed;
  assert.equal(second.flushContent(), "新的正文");
  current = Symbol("replacement");
  assert.throws(() => second.flushContent(), /no longer active/);
  guard.invalidate();
  assert.equal(reads, 2, "stale handles never reach the underlying input buffer");
});

test("a replaced editor instance cannot publish changes, focus handles, or errors", () => {
  const fixture = createMainFixture();
  const {createEditorCallbackGuard} = fixture.loadModule("plugins/body-editor/editorCallbackGuard.ts");
  let currentToken;
  const changes = [];
  const ready = [];
  const errors = [];
  const handlers = {
    onChange: content => changes.push(content),
    onReady: handle => ready.push(handle),
    onError: error => errors.push(error),
  };

  const oldToken = Symbol("old-editor");
  currentToken = oldToken;
  const oldGuard = createEditorCallbackGuard(oldToken, token => token === currentToken, handlers);
  const oldHandle = {focus() {}};
  const oldError = new Error("old editor failed");
  oldGuard.onChange("before retry");
  oldGuard.onReady(oldHandle);
  oldGuard.onError(oldError);

  const newToken = Symbol("new-editor");
  currentToken = newToken;
  const newGuard = createEditorCallbackGuard(newToken, token => token === currentToken, handlers);
  const newHandle = {focus() {}};
  const newError = new Error("current editor failed");
  newGuard.onChange("after retry");
  newGuard.onReady(newHandle);
  newGuard.onError(newError);

  oldGuard.onChange("stale change");
  oldGuard.onReady(null);
  oldGuard.onError(new Error("stale error"));
  oldGuard.invalidate();
  oldGuard.invalidate();

  assert.deepEqual(changes, ["before retry", "after retry"]);
  assert.deepEqual(ready, [oldHandle, newHandle], "invalidating a stale instance does not clear the current handle");
  assert.deepEqual(errors, [oldError, newError]);

  newGuard.invalidate();
  newGuard.invalidate();
  newGuard.onChange("after unmount");
  newGuard.onReady({focus() {}});
  newGuard.onError(new Error("after unmount"));
  assert.deepEqual(changes, ["before retry", "after retry"]);
  assert.deepEqual(ready, [oldHandle, newHandle, null], "the current handle is cleared once on invalidation");
  assert.deepEqual(errors, [oldError, newError]);
});

test("context menu actions stay dynamic and cached actions cannot run after replacement", async () => {
  const fixture = createMainFixture();
  const {createEditorCallbackGuard} = fixture.loadModule("plugins/body-editor/editorCallbackGuard.ts");
  const oldToken = Symbol("old-editor");
  let currentToken = oldToken;
  const calls = [];
  const ready = [];
  let actions = [{id: "convert", label: "转换", run: () => calls.push("old") }];
  const sourceHandle = {
    focus() {},
    getContextMenuActions: () => actions,
  };
  const guard = createEditorCallbackGuard(oldToken, token => token === currentToken, {
    onChange() {},
    onReady: handle => ready.push(handle),
    onError() {},
  });

  guard.onReady(sourceHandle);
  const guardedHandle = ready[0];
  assert.notEqual(guardedHandle, sourceHandle, "handles with menu actions are wrapped by the lifecycle guard");
  const cachedAction = guardedHandle.getContextMenuActions()[0];
  await cachedAction.run();
  assert.deepEqual(calls, ["old"]);

  actions = [{id: "convert", label: "转换中…", disabled: true, run: () => calls.push("new") }];
  const freshAction = guardedHandle.getContextMenuActions()[0];
  assert.equal(freshAction.label, "转换中…", "each getter call returns the source's current action snapshot");
  assert.equal(freshAction.disabled, true);

  currentToken = Symbol("replacement-editor");
  await cachedAction.run();
  await freshAction.run();
  assert.equal(guardedHandle.getContextMenuActions().length, 0, "a stale handle no longer exposes actions");
  assert.deepEqual(calls, ["old"], "cached actions cannot run after the attempt is replaced");
  guard.invalidate();
  assert.deepEqual(ready, [guardedHandle], "a stale guard cannot clear the replacement's handle");
});
