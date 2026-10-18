import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

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

test("a failed save-as request rejects locally without invalidating the editor instance", async () => {
  const fixture = createMainFixture();
  const {createEditorCallbackGuard} = fixture.loadModule("plugins/body-editor/editorCallbackGuard.ts");
  const token = Symbol("editor");
  let currentToken = token;
  const changes = [];
  const ready = [];
  const errors = [];
  const saveError = new Error("目标文件已存在");
  const handle = {focus() {}};
  const guard = createEditorCallbackGuard(token, candidate => candidate === currentToken, {
    onChange: content => changes.push(content),
    onReady: value => ready.push(value),
    onError: error => errors.push(error),
    onSaveAs: async () => { throw saveError; },
  });

  guard.onReady(handle);
  await assert.rejects(guard.onSaveAs({extension: "lode", content: "delta"}), saveError);
  guard.onChange("still editable");
  assert.deepEqual(changes, ["still editable"]);
  assert.deepEqual(ready, [handle], "a recoverable file conflict leaves the editor handle mounted");
  assert.deepEqual(errors, [], "save-as conflicts are not promoted to fatal editor errors");

  currentToken = Symbol("replacement");
  await assert.rejects(guard.onSaveAs({extension: "lode", content: "stale"}), /no longer active/);
  assert.deepEqual(changes, ["still editable"]);
  assert.deepEqual(errors, []);
});
