import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/documents/createDocumentWorkspace.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFilesStore({disk = new Map(), failSave = false, failDelete = false, openGate, createGate} = {}) {
  const buffers = new Map();
  const listeners = new Set();
  const calls = [];
  const saveGates = new Map();
  let blocked = false;
  let error = null;
  let snapshot = Object.freeze({files: Object.freeze([]), blocked, error});
  const freezeFile = (file) => Object.freeze({...file});
  const publish = () => {
    snapshot = Object.freeze({files: Object.freeze([...buffers.values()].map(item => item.file)), blocked, error});
    for (const listener of [...listeners]) listener();
  };
  const setBlocked = (value) => { blocked = value; publish(); };
  const fail = (message) => { error = message; publish(); };
  function install(path, content, savedContent = content, saveState = "saved", saveError = null) {
    const file = freezeFile({path, fileName: path.split("/").at(-1), content,
      dirty: content !== savedContent, saveState, saveError});
    buffers.set(path, {file, savedContent});
    publish();
    return file;
  }
  const files = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open(path) {
      calls.push(["open", path]);
      const gate = typeof openGate === "function" ? openGate(path) : openGate;
      if (gate) await gate.promise;
      if (blocked) { fail("存储正忙"); return null; }
      const current = buffers.get(path);
      if (current?.file.dirty || current?.file.saveState === "saving") return current.file;
      return install(path, disk.get(path) ?? `disk:${path}`);
    },
    async create(parentPath, name, content = "") {
      calls.push(["create", parentPath, name, content]);
      if (createGate) await createGate.promise;
      if (blocked) { fail("存储正忙"); return null; }
      const path = [parentPath, name].filter(Boolean).join("/");
      if (disk.has(path)) { fail("文件已存在"); return null; }
      disk.set(path, content);
      error = null;
      return install(path, content);
    },
    async createDirectory(parentPath, name) {
      calls.push(["createDirectory", parentPath, name]);
      if (blocked) { fail("存储正忙"); return null; }
      error = null;
      return [parentPath, name].filter(Boolean).join("/");
    },
    update(path, content) {
      if (blocked) return false;
      const current = buffers.get(path);
      if (!current) return false;
      error = null;
      return !!install(path, content, current.savedContent, content === current.savedContent ? "saved" : "pending");
    },
    async save(path) {
      calls.push(["save", path]);
      const current = buffers.get(path);
      if (!current) return false;
      buffers.set(path, {file: freezeFile({...current.file, saveState: "saving", saveError: null}), savedContent: current.savedContent});
      publish();
      const gate = saveGates.get(path);
      if (gate) await gate.promise;
      await Promise.resolve();
      if (typeof failSave === "function" ? failSave(path) : failSave) {
        buffers.set(path, {file: freezeFile({...buffers.get(path).file, saveState: "error", saveError: "磁盘不可写"}), savedContent: current.savedContent});
        fail("磁盘不可写");
        return false;
      }
      const latest = buffers.get(path).file;
      disk.set(path, latest.content);
      buffers.set(path, {file: freezeFile({...latest, dirty: false, saveState: "saved", saveError: null}), savedContent: latest.content});
      error = null;
      publish();
      return true;
    },
    async saveAll() {
      calls.push(["saveAll"]);
      for (const path of buffers.keys()) {
        if (buffers.get(path).file.dirty && !await files.save(path)) return false;
      }
      return true;
    },
    async delete(path, options = {}) {
      calls.push(["delete", path, {...options}]);
      const current = buffers.get(path);
      if (current?.file.dirty && options.discardChanges !== true) {
        fail("文档有未保存修改；确认后才能删除。");
        return false;
      }
      if (failDelete) { fail("删除失败"); return false; }
      disk.delete(path);
      buffers.delete(path);
      error = null;
      publish();
      return true;
    },
    clearError() { if (error !== null) { error = null; publish(); } },
  };
  return {
    files, calls, disk, setBlocked, install,
    setFailSave(value) { failSave = value; },
    setSaveGate(path, gate) { saveGates.set(path, gate); },
    setError(message) { error = message; publish(); },
  };
}

function createWorkspace(files, options = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) { throw new Error(`Unexpected import: ${name}`); },
    console,
  });
  return exports.createDocumentWorkspace(files, options);
}

const idFor = path => encodeURIComponent(path);

test("documents own tab selection while the text store owns the shared content buffer", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  assert.equal(await workspace.service.open("第一章.md"), true);
  assert.equal(await workspace.service.open("第二章.md"), true);
  const first = workspace.service.getSnapshot().documents[0];
  assert.equal(workspace.service.getSnapshot().activeId, idFor("第二章.md"));
  assert.equal(workspace.service.select(first.id), true);

  assert.equal(workspace.service.update(first.id, "共享草稿"), true);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "共享草稿");
  assert.equal(store.files.getSnapshot().files[0].content, "共享草稿");
  assert.equal(await workspace.service.save(first.id), true);
  assert.equal(await workspace.service.close(first.id), true);
  assert.equal(workspace.service.getSnapshot().documents.some(file => file.id === first.id), false);
  assert.equal(store.files.getSnapshot().files.some(file => file.path === first.path), true, "closing a tab does not destroy its store buffer");

  assert.equal(await workspace.service.open(first.path), true);
  assert.equal(workspace.service.getSnapshot().documents.find(file => file.id === first.id).content, "共享草稿");
  assert.deepEqual(store.calls.filter(([operation]) => operation === "open").map(([, path]) => path), ["第一章.md", "第二章.md", "第一章.md"]);
  await workspace.dispose();
});

test("an accepted open calls storage synchronously and drains before leave", async () => {
  const gate = deferred();
  const store = createFilesStore({openGate: gate});
  let canMutate = true;
  const workspace = createWorkspace(store.files, {canMutate: () => canMutate});
  workspace.service.subscribe(() => {
    if (workspace.service.getSnapshot().openingPath) canMutate = false;
  });

  const opening = workspace.service.open("延迟打开.md");
  assert.deepEqual(store.calls[0], ["open", "延迟打开.md"], "the storage request starts before subscribers can make the workbench busy");
  const leaving = workspace.beforeLeave();
  assert.equal(await workspace.service.open("不应接受.md"), false);
  gate.resolve();
  assert.equal(await opening, true);
  assert.equal(await leaving, true);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, file => file.path), ["延迟打开.md"]);
  await workspace.dispose();
});

test("create keeps document extension rules and starts the shared store operation immediately", async () => {
  const gate = deferred();
  const store = createFilesStore({createGate: gate});
  let canMutate = true;
  const workspace = createWorkspace(store.files, {canMutate: () => canMutate});
  const creating = workspace.service.create("卷一", "第一章");
  assert.deepEqual(store.calls[0], ["create", "卷一", "第一章.md", ""]);
  canMutate = false;
  const leaving = workspace.beforeLeave();
  gate.resolve();
  assert.equal((await creating).path, "卷一/第一章.md");
  assert.equal(await leaving, true);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "");
  await workspace.dispose();
});

test("deletion delegates dirty draft confirmation and discards only after explicit confirmation", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const document = await workspace.service.create("", "第一章.md");
  workspace.service.update(document.id, "未保存草稿");

  assert.equal(await workspace.service.deleteDocument(document.path), false);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "未保存草稿");
  assert.match(workspace.service.getSnapshot().error, /未保存修改/);
  assert.deepEqual(store.calls.at(-1), ["delete", document.path, {}]);

  assert.equal(await workspace.service.deleteDocument(document.path, {discardChanges: true}), true);
  assert.equal(workspace.service.getSnapshot().documents.length, 0);
  assert.equal(store.disk.has(document.path), false);
  await workspace.dispose();
});

test("a storage save failure keeps and selects the document, and requests reveal", async () => {
  const store = createFilesStore();
  const revealed = [];
  const workspace = createWorkspace(store.files, {onReveal: id => revealed.push(id)});
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  workspace.service.update(first.id, "不能丢失的草稿");
  store.setFailSave(true);

  assert.equal(await workspace.service.save(first.id), false);
  const snapshot = workspace.service.getSnapshot();
  assert.equal(snapshot.activeId, first.id);
  assert.equal(snapshot.documents.find(file => file.id === first.id).content, "不能丢失的草稿");
  assert.equal(snapshot.documents.find(file => file.id === first.id).saveError, "磁盘不可写");
  assert.equal(revealed.at(-1), first.id);

  store.setFailSave(false);
  assert.equal(await workspace.service.save(first.id), true);
  assert.equal(workspace.service.select(second.id), true);
  await workspace.dispose();
});

test("saveAs retains supported formats and rejects missing or unsupported formats", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const source = await workspace.service.create("卷一", "第一章");
  await workspace.service.saveAs(source.id, "第一章.lode", "rich-delta-envelope");
  assert.deepEqual(store.calls.find(([operation, , name]) => operation === "create" && name === "第一章.lode"),
    ["create", "卷一", "第一章.lode", "rich-delta-envelope"]);
  assert.equal(workspace.service.getSnapshot().documents.some(file => file.path === "卷一/第一章.lode"), true);
  await assert.rejects(workspace.service.saveAs(source.id, "bad.exe", "x"), /另存文件名或内容无效/);
  await workspace.dispose();
});

test("dispose delegates pending save to storage and retains a recoverable snapshot on failure", async () => {
  const store = createFilesStore({failSave: true});
  const workspace = createWorkspace(store.files);
  const document = await workspace.service.create("", "草稿.md");
  workspace.service.update(document.id, "恢复内容");
  let failure;
  try { await workspace.dispose(); } catch (cause) { failure = cause; }
  assert.ok(failure);
  assert.equal(failure.snapshot.documents[0].content, "恢复内容");
  assert.equal(failure.snapshot.documents[0].saveState, "error");
  assert.equal(failure.snapshot.error, "磁盘不可写");
  assert.equal(workspace.service.getSnapshot(), failure.snapshot);
});

test("a later open supersedes an older read without installing stale membership", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const store = createFilesStore({openGate: path => path === "第一章.md" ? firstGate : secondGate});
  const workspace = createWorkspace(store.files);
  const openingFirst = workspace.service.open("第一章.md");
  const openingSecond = workspace.service.open("第二章.md");
  secondGate.resolve();
  assert.equal(await openingSecond, true);
  firstGate.resolve();
  assert.equal(await openingFirst, false);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, document => document.path), ["第二章.md"]);
  assert.equal(workspace.service.getSnapshot().activeId, idFor("第二章.md"));
  await workspace.dispose();
});

test("selecting an already-open tab supersedes a pending read", async () => {
  const delayed = deferred();
  const store = createFilesStore({openGate: path => path === "延迟打开.md" ? delayed : null});
  const workspace = createWorkspace(store.files);
  const existing = await workspace.service.create("", "已打开.md");
  const opening = workspace.service.open("延迟打开.md");
  assert.equal(workspace.service.select(existing.id), true);
  delayed.resolve();
  assert.equal(await opening, false);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, document => document.path), ["已打开.md"]);
  assert.equal(workspace.service.getSnapshot().activeId, existing.id);
  await workspace.dispose();
});

test("close reentry shares the real in-flight promise", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const document = await workspace.service.create("", "第一章.md");
  workspace.service.update(document.id, "需要保存");
  const gate = deferred();
  store.setSaveGate(document.path, gate);
  let nestedClose;
  const unsubscribe = workspace.service.subscribe(() => {
    if (workspace.service.getSnapshot().documents[0]?.saveState === "saving" && !nestedClose) {
      nestedClose = workspace.service.close(document.id);
    }
  });

  const closing = workspace.service.close(document.id);
  assert.equal(nestedClose, closing, "synchronous storage notification reentry receives the same close operation");
  gate.resolve();
  assert.equal(await closing, true);
  assert.equal(workspace.service.getSnapshot().documents.length, 0);
  unsubscribe();
  await workspace.dispose();
});

test("closeMany skips a target whose tab was closed and reopened at the same path", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  workspace.service.update(first.id, "保存第一章");
  const gate = deferred();
  store.setSaveGate(first.path, gate);

  const closing = workspace.service.closeMany([first.id, second.id]);
  assert.deepEqual(store.calls.at(-1), ["save", first.path]);
  assert.equal(await workspace.service.close(second.id), true);
  assert.equal(await workspace.service.open(second.path), true);
  gate.resolve();

  assert.equal(await closing, true);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, document => document.path), [second.path]);
  assert.equal(workspace.service.getSnapshot().documents[0].content, "");
  await workspace.dispose();
});

test("closeMany stops at the first failed save and leaves later tabs open", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  const third = await workspace.service.create("", "第三章.md");
  workspace.service.update(first.id, "第一章修改");
  workspace.service.update(second.id, "第二章修改");
  workspace.service.update(third.id, "第三章修改");
  store.setFailSave(path => path === second.path);

  assert.equal(await workspace.service.closeMany([first.id, second.id, third.id]), false);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, document => document.path), [second.path, third.path]);
  assert.equal(workspace.service.getSnapshot().activeId, second.id);
  assert.deepEqual(store.calls.filter(([operation]) => operation === "save").map(([, path]) => path), [first.path, second.path]);
  store.setFailSave(false);
  await workspace.dispose();
});

test("closeMany stops after leave starts, while leave saves the remaining open tabs", async () => {
  let canMutate = true;
  const store = createFilesStore();
  const workspace = createWorkspace(store.files, {canMutate: () => canMutate});
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  workspace.service.update(first.id, "保存第一章");
  workspace.service.update(second.id, "保存第二章");
  const gate = deferred();
  store.setSaveGate(first.path, gate);

  const closing = workspace.service.closeMany([first.id, second.id]);
  canMutate = false;
  const leaving = workspace.beforeLeave();
  gate.resolve();
  assert.equal(await closing, false);
  assert.equal(await leaving, true);
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents, document => document.path), [second.path]);
  assert.equal(store.disk.get(second.path), "保存第二章", "the leave check saves the open tab after the close flow stops");
  await workspace.dispose();
});

test("document saveAll touches only this workspace's open tabs and hides unrelated storage errors", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const opened = await workspace.service.create("", "已打开.md");
  store.install("后台插件.md", "other draft", "disk baseline", "pending");
  workspace.service.update(opened.id, "打开的草稿");
  store.setError("其他消费者的错误");
  assert.equal(workspace.service.getSnapshot().error, null);

  assert.equal(await workspace.service.saveAll(), true);
  assert.equal(store.disk.get(opened.path), "打开的草稿");
  assert.equal(store.files.getSnapshot().files.find(file => file.path === "后台插件.md").dirty, true);
  assert.equal(store.calls.filter(([operation]) => operation === "save").some(([, path]) => path === "后台插件.md"), false);
  await workspace.dispose();
});

test("dispose reentry shares its promise and drains accepted closeMany work", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  const first = await workspace.service.create("", "第一章.md");
  const second = await workspace.service.create("", "第二章.md");
  workspace.service.update(first.id, "第一章修改");
  const gate = deferred();
  store.setSaveGate(first.path, gate);
  const closing = workspace.service.closeMany([first.id, second.id]);
  let nestedDisposal;
  workspace.service.subscribe(() => {
    const snapshot = workspace.service.getSnapshot();
    if (snapshot.blocked && snapshot.documents.length === 0 && !nestedDisposal) nestedDisposal = workspace.dispose();
  });
  const disposal = workspace.dispose();
  assert.equal(nestedDisposal, disposal);
  gate.resolve();
  assert.equal(await closing, false);
  await disposal;
  assert.deepEqual(Array.from(workspace.service.getSnapshot().documents), []);
});

test("workspace errors reflect its own failed operation, not another consumer's storage error", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  store.setError("无关消费者错误");
  assert.equal(workspace.service.getSnapshot().error, null);
  store.files.open = async () => { throw new Error("当前文档打开失败"); };
  assert.equal(await workspace.service.open("失败.md"), false);
  assert.equal(workspace.service.getSnapshot().error, "当前文档打开失败");
  await workspace.dispose();
});

test("the document workspace no longer imports a private save session or document filesystem API", () => {
  assert.doesNotMatch(source, /DocumentSession|documentApi/);
});
