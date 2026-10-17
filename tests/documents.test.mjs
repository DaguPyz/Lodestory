import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/documents/DocumentSession.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const workspaceSource = await readFile(new URL("../src/plugins/documents/createDocumentWorkspace.ts", import.meta.url), "utf8");
const workspaceCompiled = ts.transpileModule(workspaceSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(write, changed = () => {}) {
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
  const session = new exports.DocumentSession({ path: "正文/第一章.md", fileName: "第一章.md", content: "原正文" }, write, changed);
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

function createWorkspaceFactory({
  read = async (projectPath, path) => record(path, "正文"),
  create = async (_projectPath, parentPath, name) => record([parentPath, name].filter(Boolean).join("/")),
  write = async () => {},
} = {}) {
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
        createDocument: create,
        saveDocument: write,
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return workspaceExports.createDocumentWorkspace;
}

const record = (path, content = "正文") => ({ path, fileName: path.split("/").at(-1), content });
const documentId = (path) => encodeURIComponent(path);

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

test("a throwing change listener cannot strand save or dispose", async () => {
  const writes = [];
  let throwOnChange = false;
  const saved = fixture(async (...args) => { writes.push(args); }, () => {
    if (throwOnChange) throw new Error("subscriber failed");
  });
  saved.session.update("save 的正文");
  throwOnChange = true;
  assert.equal(await saved.session.save(), true);

  throwOnChange = false;
  const disposed = fixture(async (...args) => { writes.push(args); }, () => {
    if (throwOnChange) throw new Error("subscriber failed");
  });
  disposed.session.update("dispose 的正文");
  throwOnChange = true;
  assert.equal(await disposed.session.dispose(), true);
  assert.deepEqual(writes, [
    ["正文/第一章.md", "save 的正文", "原正文"],
    ["正文/第一章.md", "dispose 的正文", "原正文"],
  ]);
});

test("separate project workspaces keep document sessions and writes isolated", async () => {
  const writes = [];
  const createDocumentWorkspace = createWorkspaceFactory({ write: async (...args) => { writes.push(args); } });
  const first = createDocumentWorkspace("/projects/first");
  const second = createDocumentWorkspace("/projects/second");
  const firstDocument = await first.service.create("", "第一章.md");
  const secondDocument = await second.service.create("", "第一章.md");

  assert.equal(firstDocument.content, "正文");
  assert.equal(secondDocument.content, "正文");
  first.service.update(documentId("第一章.md"), "项目一修改");
  assert.equal(first.service.getSnapshot().documents[0].content, "项目一修改");
  assert.equal(second.service.getSnapshot().documents[0].content, "正文");
  assert.equal(await first.service.saveAll(), true);
  assert.deepEqual(writes, [["/projects/first", "第一章.md", "项目一修改", "正文"]]);
  await Promise.all([first.dispose(), second.dispose()]);
});

test("the snapshot is stable between changes and deeply immutable", async () => {
  const workspace = createWorkspaceFactory()("/projects/book");
  await workspace.service.create("", "第一章.md");
  const first = workspace.service.getSnapshot();
  assert.equal(workspace.service.getSnapshot(), first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.documents));
  assert.ok(Object.isFrozen(first.documents[0]));
  assert.throws(() => { first.documents[0].content = "伪造修改"; }, TypeError);

  workspace.service.update(documentId("第一章.md"), "真实修改");
  const second = workspace.service.getSnapshot();
  assert.notEqual(second, first);
  assert.equal(first.documents[0].content, "正文", "a published snapshot must not change later");
  assert.equal(second.documents[0].content, "真实修改");
  await workspace.dispose();
});

test("a busy workbench blocks service mutations and refreshes the blocked snapshot", async () => {
  let canMutate = false;
  const workspace = createWorkspaceFactory()("/projects/book", { canMutate: () => canMutate });
  assert.equal(await workspace.service.open("第一章.md"), false);
  assert.equal(await workspace.service.create("", "第一章.md"), null);
  assert.equal(workspace.service.select(documentId("第一章.md")), false);
  assert.equal(workspace.service.update(documentId("第一章.md"), "修改"), false);
  assert.equal(await workspace.service.close(documentId("第一章.md")), false);
  assert.equal(workspace.service.getSnapshot().documents.length, 0);
  assert.equal(workspace.service.getSnapshot().blocked, true);

  canMutate = true;
  workspace.refreshBlocked();
  assert.equal(workspace.service.getSnapshot().blocked, false);
  assert.equal(await workspace.service.open("第一章.md"), true);
  await workspace.dispose();
});

test("beforeLeave blocks new changes and waits for an accepted open", async () => {
  const read = deferred();
  const writes = [];
  let canMutate = true;
  const workspace = createWorkspaceFactory({
    read: () => read.promise,
    write: async (...args) => { writes.push(args); },
  })("/projects/book", { canMutate: () => canMutate });
  const opening = workspace.service.open("打开中.md");
  assert.equal(workspace.service.getSnapshot().openingPath, "打开中.md");

  canMutate = false;
  const leaving = workspace.beforeLeave();
  assert.equal(workspace.service.getSnapshot().blocked, true);
  assert.equal(await workspace.service.open("拒绝.md"), false);
  read.resolve(record("打开中.md", "打开内容"));
  assert.equal(await opening, true);
  assert.equal(await leaving, true);
  assert.equal(workspace.service.getSnapshot().documents.length, 1);
  assert.deepEqual(writes, [], "clean documents need no writes during leave");

  canMutate = true;
  workspace.refreshBlocked();
  assert.equal(workspace.service.getSnapshot().blocked, false);
  await workspace.dispose();
});

test("beforeLeave waits for a create already accepted before the workbench became busy", async () => {
  const create = deferred();
  let canMutate = true;
  const workspace = createWorkspaceFactory({ create: () => create.promise })("/projects/book", {
    canMutate: () => canMutate,
  });
  const creating = workspace.service.create("目录", "新建中.md");
  assert.equal(workspace.service.getSnapshot().creating, true);
  canMutate = false;
  const leaving = workspace.beforeLeave();
  assert.equal(workspace.service.getSnapshot().blocked, true);
  create.resolve(record("目录/新建中.md", "新建内容"));
  assert.equal((await creating).path, "目录/新建中.md");
  assert.equal(await leaving, true);
  assert.equal(workspace.service.getSnapshot().documents.length, 1);
  canMutate = true;
  workspace.refreshBlocked();
  await workspace.dispose();
});

test("save serializes edits made in flight and keeps the newest content", async () => {
  const firstWrite = deferred();
  const writes = [];
  const workspace = createWorkspaceFactory({
    write: async (...args) => {
      writes.push(args);
      if (writes.length === 1) await firstWrite.promise;
    },
  })("/projects/book");
  await workspace.service.create("", "第一章.md");
  const id = documentId("第一章.md");
  workspace.service.update(id, "第一次修改");
  const saving = workspace.service.save(id);
  workspace.service.update(id, "第二次修改");
  firstWrite.resolve();

  assert.equal(await saving, true);
  assert.deepEqual(writes, [
    ["/projects/book", "第一章.md", "第一次修改", "正文"],
    ["/projects/book", "第一章.md", "第二次修改", "第一次修改"],
  ]);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "第二次修改");
  assert.equal(workspace.service.getSnapshot().documents[0].saveState, "saved");
  await workspace.dispose();
});

test("save subscription reentry shares the write and includes an edit from the saved notification microtask", async () => {
  const gate = deferred();
  const writes = [];
  const workspace = createWorkspaceFactory({
    write: async (...args) => {
      writes.push(args);
      if (writes.length === 1) await gate.promise;
    },
  })("/projects/book");
  await workspace.service.create("", "第一章.md");
  const id = documentId("第一章.md");
  let reenteredSave;
  let reentered = false;
  let scheduledEdit = false;
  const unsubscribe = workspace.service.subscribe(() => {
    const document = workspace.service.getSnapshot().documents[0];
    if (document?.saveState === "saving" && !reentered) {
      reentered = true;
      reenteredSave = workspace.service.save(id);
    }
    if (document?.saveState === "saved" && reentered && !scheduledEdit) {
      scheduledEdit = true;
      queueMicrotask(() => workspace.service.update(id, "saved 通知后的编辑"));
    }
  });
  workspace.service.update(id, "初次修改");
  const saving = workspace.service.save(id);
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(await reenteredSave, true);
  assert.deepEqual(writes, [
    ["/projects/book", "第一章.md", "初次修改", "正文"],
    ["/projects/book", "第一章.md", "saved 通知后的编辑", "初次修改"],
  ]);
  assert.equal(workspace.service.getSnapshot().documents[0].saveState, "saved");
  unsubscribe();
  await workspace.dispose();
});

test("a reveal callback failure cannot roll back a successful document operation or mask save failure", async () => {
  let failWrites = false;
  const workspace = createWorkspaceFactory({
    write: async () => { if (failWrites) throw new Error("保存失败"); },
  })("/projects/book", { onReveal() { throw new Error("页面当前不可用"); } });
  const created = await workspace.service.create("", "第一章.md");
  assert.equal(created.path, "第一章.md");
  const id = documentId("第一章.md");
  workspace.service.update(id, "草稿");
  failWrites = true;
  assert.equal(await workspace.service.save(id), false);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "草稿");
  failWrites = false;
  assert.equal(await workspace.service.save(id), true);
  await workspace.dispose();
});

test("a failed workspace save retains its draft and reports the error", async () => {
  const workspace = createWorkspaceFactory({ write: async () => { throw new Error("磁盘不可写"); } })("/projects/book");
  await workspace.service.create("", "第一章.md");
  const id = documentId("第一章.md");
  workspace.service.update(id, "保留的草稿");
  assert.equal(await workspace.service.save(id), false);
  const document = workspace.service.getSnapshot().documents[0];
  assert.equal(document.content, "保留的草稿");
  assert.equal(document.saveState, "error");
  assert.equal(document.saveError, "磁盘不可写");
  await assert.rejects(workspace.dispose(), /could not be saved/i);
});

test("beforeLeave refuses to discard failed drafts and selects the first failed document", async () => {
  let failWrites = true;
  let canMutate = true;
  const revealed = [];
  const workspace = createWorkspaceFactory({
    write: async () => { if (failWrites) throw new Error("磁盘不可写"); },
  })("/projects/book", {
    canMutate: () => canMutate,
    onReveal: (id) => revealed.push(id),
  });
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  workspace.service.update(first.id, "第一章草稿");
  workspace.service.update(second.id, "第二章草稿");
  canMutate = false;

  assert.equal(await workspace.beforeLeave(), false);
  const snapshot = workspace.service.getSnapshot();
  assert.equal(snapshot.activeId, first.id);
  assert.equal(snapshot.documents[0].content, "第一章草稿");
  assert.equal(snapshot.documents[1].content, "第二章草稿");
  assert.equal(snapshot.documents[0].saveState, "error");
  assert.equal(snapshot.documents[1].saveState, "error");
  assert.equal(revealed.at(-1), first.id);

  canMutate = true;
  workspace.refreshBlocked();
  failWrites = false;
  assert.equal(await workspace.beforeLeave(), true);
  await workspace.dispose();
});

test("a later open supersedes the older read and neither installs stale content", async () => {
  const first = deferred();
  const second = deferred();
  const workspace = createWorkspaceFactory({
    read: (_projectPath, path) => path === "第一章.md" ? first.promise : second.promise,
  })("/projects/book");
  const openingFirst = workspace.service.open("第一章.md");
  const openingSecond = workspace.service.open("第二章.md");
  second.resolve(record("第二章.md", "第二章"));
  assert.equal(await openingSecond, true);
  first.resolve(record("第一章.md", "迟到的第一章"));
  assert.equal(await openingFirst, false);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, ({ path }) => path), ["第二章.md"]);
  assert.equal(workspace.service.getSnapshot().activeId, documentId("第二章.md"));
  assert.equal(workspace.service.getSnapshot().openingPath, null);
  await workspace.dispose();
});

test("selecting another open document supersedes a pending read without installing its result", async () => {
  const pendingRead = deferred();
  const workspace = createWorkspaceFactory({ read: () => pendingRead.promise })("/projects/book");
  await workspace.service.create("", "已打开.md");
  const activeId = documentId("已打开.md");
  const opening = workspace.service.open("延迟打开.md");
  assert.equal(workspace.service.select(activeId), true);
  pendingRead.resolve(record("延迟打开.md", "延迟正文"));
  assert.equal(await opening, false);
  assert.equal(workspace.service.getSnapshot().activeId, activeId);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, ({ path }) => path), ["已打开.md"]);
  await workspace.dispose();
});

test("close locks out concurrent edits until the current document is saved and removed", async () => {
  const write = deferred();
  const writes = [];
  const workspace = createWorkspaceFactory({
    write: async (...args) => { writes.push(args); await write.promise; },
  })("/projects/book");
  await workspace.service.create("", "第一章.md");
  const id = documentId("第一章.md");
  workspace.service.update(id, "关闭前内容");
  const closing = workspace.service.close(id);
  assert.equal(workspace.service.update(id, "并发新内容"), false);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "关闭前内容");
  write.resolve();
  assert.equal(await closing, true);
  assert.equal(workspace.service.getSnapshot().documents.length, 0);
  assert.deepEqual(writes, [["/projects/book", "第一章.md", "关闭前内容", "正文"]]);
  await workspace.dispose();
});

test("dispose invalidates handles and waits for accepted operations and in-flight saves", async () => {
  const pendingRead = deferred();
  const pendingWrite = deferred();
  const writes = [];
  const workspace = createWorkspaceFactory({
    read: () => pendingRead.promise,
    write: async (...args) => { writes.push(args); await pendingWrite.promise; },
  })("/projects/book");
  const service = workspace.service;
  await service.create("", "已打开.md");
  const id = documentId("已打开.md");
  service.update(id, "离开前的修改");
  const saving = service.save(id);
  const opening = service.open("打开中.md");
  const disposal = workspace.dispose();
  const stoppedSnapshot = service.getSnapshot();
  assert.equal(stoppedSnapshot.documents.length, 0);
  assert.equal(stoppedSnapshot.openingPath, null);
  assert.equal(await service.open("旧句柄.md"), false);
  assert.equal(await service.create("", "旧句柄.md"), null);
  assert.equal(service.update(documentId("打开中.md"), "旧写入"), false);
  assert.equal(await service.save(id), false);
  assert.equal(await service.saveAll(), false);

  pendingRead.resolve(record("打开中.md", "迟到结果"));
  assert.equal(await opening, false);
  assert.equal(writes.length, 1);
  pendingWrite.resolve();
  assert.equal(await saving, true);
  await disposal;
  assert.equal(service.getSnapshot(), stoppedSnapshot);
  assert.deepEqual(writes, [["/projects/book", "已打开.md", "离开前的修改", "正文"]]);
});

test("forced dispose rejects with the terminal draft snapshot and keeps that snapshot readable", async () => {
  const workspace = createWorkspaceFactory({
    write: async () => { throw new Error("磁盘不可写"); },
  })("/projects/book");
  await workspace.service.create("", "草稿.md");
  const id = documentId("草稿.md");
  workspace.service.update(id, "不能丢失的草稿");
  const service = workspace.service;

  let failure;
  try { await workspace.dispose(); }
  catch (error) { failure = error; }
  assert.ok(failure, "forced shutdown must report that its final write failed");
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.documents[0].content, "不能丢失的草稿");
  assert.equal(snapshot.documents[0].saveState, "error");
  assert.equal(failure.snapshot, snapshot);
  assert.equal(failure.snapshot.documents[0].content, "不能丢失的草稿");
  assert.equal(service.update(id, "旧句柄不能再编辑"), false);
  assert.equal(await service.save(id), false);
});

test("dispose subscription reentry returns the same in-flight disposal promise", async () => {
  const workspace = createWorkspaceFactory()("/projects/book");
  await workspace.service.create("", "第一章.md");
  let nestedDisposal;
  const unsubscribe = workspace.service.subscribe(() => {
    const snapshot = workspace.service.getSnapshot();
    if (snapshot.blocked && snapshot.documents.length === 0) nestedDisposal = workspace.dispose();
  });

  const disposal = workspace.dispose();
  assert.equal(nestedDisposal, disposal);
  await disposal;
  unsubscribe();
});
