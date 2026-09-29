import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/documents/DocumentSession.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(write) {
  const timers = new Map();
  let timerId = 0;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "./documentApi") return { documentErrorMessage: (error) => error.message };
      throw new Error(`Unexpected import: ${name}`);
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const session = new exports.DocumentSession({ path: "正文/第一章.md", fileName: "第一章.md", content: "原正文" }, write, () => {});
  return {
    session,
    flushTimer() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    timerCount: () => timers.size,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("editing schedules autosave, saves the latest content, and skips unchanged documents", async () => {
  const writes = [];
  const { session, flushTimer } = fixture(async (...args) => { writes.push(args); });
  session.update("第一段");
  session.update("第一段\n第二段");
  assert.equal(session.document.saveState, "pending");
  assert.equal(writes.length, 0);
  flushTimer();
  assert.equal(await session.save(), true);
  assert.deepEqual(writes, [["正文/第一章.md", "第一段\n第二段", "原正文"]]);
  assert.equal(session.document.saveState, "saved");
  await session.save();
  assert.equal(writes.length, 1);
});

test("edits made during saving are serialized with the correct previous content", async () => {
  const first = deferred();
  const writes = [];
  const { session } = fixture(async (...args) => {
    writes.push(args);
    if (writes.length === 1) await first.promise;
  });
  session.update("第一次修改");
  const saving = session.save();
  session.update("第二次修改");
  assert.equal(session.save(), saving);
  first.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(writes, [
    ["正文/第一章.md", "第一次修改", "原正文"],
    ["正文/第一章.md", "第二次修改", "第一次修改"],
  ]);
  assert.equal(session.document.content, "第二次修改");
  assert.equal(session.document.saveState, "saved");
});

test("undoing to the original content while saving persists the undo", async () => {
  const first = deferred();
  const writes = [];
  const { session } = fixture(async (...args) => { writes.push(args); if (writes.length === 1) await first.promise; });
  session.update("修改");
  const saving = session.save();
  session.update("原正文");
  first.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(writes.at(-1), ["正文/第一章.md", "原正文", "修改"]);
  assert.equal(session.document.saveState, "saved");
});

test("a failed save retains the draft and can be retried without changing its baseline", async () => {
  let fail = true;
  const writes = [];
  const { session } = fixture(async (...args) => {
    writes.push(args);
    if (fail) throw new Error("磁盘无法写入");
  });
  session.update("待保存的正文");
  assert.equal(await session.save(), false);
  assert.equal(session.document.content, "待保存的正文");
  assert.equal(session.document.saveState, "error");
  assert.equal(session.document.saveError, "磁盘无法写入");
  fail = false;
  assert.equal(await session.save(), true);
  assert.deepEqual(writes.at(-1), ["正文/第一章.md", "待保存的正文", "原正文"]);
  assert.equal(session.document.saveState, "saved");
  assert.equal(session.document.saveError, null);
});

test("leaving a workspace flushes scheduled edits instead of cancelling them", async () => {
  const writes = [];
  const { session, timerCount } = fixture(async (...args) => { writes.push(args); });
  session.update("离开前的修改");
  session.dispose();
  await session.save();
  assert.equal(timerCount(), 0);
  assert.deepEqual(writes, [["正文/第一章.md", "离开前的修改", "原正文"]]);
});
