import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/documents/DocumentSession.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const workspaceSource = await readFile(new URL("../src/documents/createDocumentWorkspace.ts", import.meta.url), "utf8");
const workspaceCompiled = ts.transpileModule(workspaceSource, {
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

function createWorkspaceFactory({ read = async () => ({ path: "第一章.md", fileName: "第一章.md", content: "正文" }), write = async () => {} } = {}) {
  const sessionExports = {};
  vm.runInNewContext(compiled, {
    exports: sessionExports,
    require(name) {
      if (name === "./documentApi") return { documentErrorMessage: (error) => error.message };
      throw new Error(`Unexpected import: ${name}`);
    },
    setTimeout(callback) { return setTimeout(callback, 100000); },
    clearTimeout(id) { clearTimeout(id); },
  });
  const workspaceExports = {};
  vm.runInNewContext(workspaceCompiled, {
    exports: workspaceExports,
    require(name) {
      if (name === "./DocumentSession") return { DocumentSession: sessionExports.DocumentSession };
      if (name === "./documentApi") return {
        documentErrorMessage: (error) => error.message,
        readDocument: read,
        saveDocument: write,
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return workspaceExports.createDocumentWorkspace;
}

const record = (path, content = "正文") => ({ path, fileName: path.split("/").at(-1), content });

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

test("separate project workspaces keep document sessions and writes isolated", async () => {
  const writes = [];
  const createDocumentWorkspace = createWorkspaceFactory({ write: async (...args) => { writes.push(args); } });
  const first = createDocumentWorkspace("/projects/first");
  const second = createDocumentWorkspace("/projects/second");
  assert.equal(first.openCreated(record("第一章.md", "项目一")), true);
  assert.equal(second.openCreated(record("第一章.md", "项目二")), true);

  first.update(encodeURIComponent("第一章.md"), "项目一修改");
  assert.equal(first.getSnapshot().documents[0].content, "项目一修改");
  assert.equal(second.getSnapshot().documents[0].content, "项目二");
  assert.equal(await first.saveAll(), true);
  assert.deepEqual(writes, [["/projects/first", "第一章.md", "项目一修改", "项目一"]]);
  await Promise.all([first.dispose(), second.dispose()]);
});

test("busy workbench blocks user mutations while allowing internal create completion", async () => {
  let canMutate = false;
  const createDocumentWorkspace = createWorkspaceFactory();
  const workspace = createDocumentWorkspace("/projects/book", { canMutate: () => canMutate });
  assert.equal(await workspace.open("第一章.md"), false);
  assert.equal(workspace.openCreated(record("第一章.md")), false);
  assert.equal(workspace.select(encodeURIComponent("第一章.md")), false);
  assert.equal(workspace.update(encodeURIComponent("第一章.md"), "修改"), false);
  assert.equal(await workspace.close(encodeURIComponent("第一章.md")), false);
  assert.equal(workspace.getSnapshot().documents.length, 0);

  assert.equal(workspace.openCreated(record("第一章.md"), { internal: true }), true);
  assert.equal(workspace.getSnapshot().documents.length, 1);
  assert.equal(await workspace.open("第一章.md"), false);
  assert.equal(workspace.select(encodeURIComponent("第一章.md")), false);
  assert.equal(await workspace.close(encodeURIComponent("第一章.md")), false);
  assert.equal(workspace.update(encodeURIComponent("第一章.md"), "仍被阻止"), false);
  canMutate = true;
  assert.equal(workspace.update(encodeURIComponent("第一章.md"), "允许编辑"), true);
  await workspace.dispose();
});

test("disposing invalidates a pending read and waits for its result without restoring state", async () => {
  const pendingRead = deferred();
  const createDocumentWorkspace = createWorkspaceFactory({ read: () => pendingRead.promise });
  const workspace = createDocumentWorkspace("/projects/book");
  let notifications = 0;
  workspace.subscribe(() => { notifications += 1; });
  const opening = workspace.open("第一章.md");
  assert.equal(workspace.getSnapshot().openingPath, "第一章.md");

  await workspace.dispose();
  const disposedSnapshot = workspace.getSnapshot();
  assert.equal(disposedSnapshot.documents.length, 0);
  assert.equal(disposedSnapshot.openingPath, null);
  pendingRead.resolve(record("第一章.md", "迟到结果"));
  assert.equal(await opening, false);
  assert.equal(workspace.getSnapshot(), disposedSnapshot);
  assert.equal(workspace.getSnapshot().documents.length, 0);
  assert.equal(notifications, 2);
});

test("dispose awaits autosaves already in flight", async () => {
  const write = deferred();
  const writes = [];
  const createDocumentWorkspace = createWorkspaceFactory({ write: async (...args) => { writes.push(args); await write.promise; } });
  const workspace = createDocumentWorkspace("/projects/book");
  const id = encodeURIComponent("第一章.md");
  workspace.openCreated(record("第一章.md", "原文"));
  workspace.update(id, "离开前修改");
  const saving = workspace.save(id);
  const disposal = workspace.dispose();
  let disposed = false;
  void disposal.then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.deepEqual(writes, [["/projects/book", "第一章.md", "离开前修改", "原文"]]);

  write.resolve();
  await disposal;
  assert.equal(disposed, true);
  assert.equal(await saving, true);
  assert.equal(workspace.getSnapshot().documents.length, 0);
});
