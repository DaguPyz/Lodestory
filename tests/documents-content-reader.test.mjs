import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/documents/createDocumentWorkspace.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function createFilesStore() {
  const buffers = new Map();
  const disk = new Map();
  const listeners = new Set();
  const calls = [];
  let error = null;
  let snapshot = Object.freeze({files: Object.freeze([]), blocked: false, error});
  const freeze = file => Object.freeze({...file});
  function publish() {
    snapshot = Object.freeze({files: Object.freeze([...buffers.values()].map(item => item.file)), blocked: false, error});
    for (const listener of [...listeners]) listener();
  }
  function install(path, content, savedContent = content) {
    const file = freeze({path, fileName: path.split("/").at(-1), content,
      dirty: content !== savedContent, saveState: content === savedContent ? "saved" : "pending", saveError: null});
    buffers.set(path, {file, savedContent});
    publish();
    return file;
  }
  const files = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open(path) {
      calls.push(["open", path]);
      const current = buffers.get(path);
      return current?.file ?? install(path, disk.get(path) ?? `disk:${path}`);
    },
    async create(parent, name, content = "") {
      const path = [parent, name].filter(Boolean).join("/");
      if (disk.has(path)) return null;
      disk.set(path, content);
      return install(path, content);
    },
    async createDirectory(parent, name) { return [parent, name].filter(Boolean).join("/"); },
    update(path, content) {
      const current = buffers.get(path);
      if (!current || typeof content !== "string") return false;
      install(path, content, current.savedContent);
      return true;
    },
    async save(path) {
      calls.push(["save", path]);
      const current = buffers.get(path);
      if (!current) return false;
      disk.set(path, current.file.content);
      buffers.set(path, {file: freeze({...current.file, dirty: false, saveState: "saved", saveError: null}),
        savedContent: current.file.content});
      publish();
      return true;
    },
    async delete(path, options = {}) {
      calls.push(["delete", path, {...options}]);
      const current = buffers.get(path);
      if (current?.file.dirty && options.discardChanges !== true) {
        error = "文档有未保存修改；确认后才能删除。";
        publish();
        return false;
      }
      buffers.delete(path);
      disk.delete(path);
      error = null;
      publish();
      return true;
    },
    clearError() { error = null; publish(); },
  };
  return {files, disk, calls};
}

function createWorkspace(files, options = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {exports, require(name) { throw new Error(`Unexpected import: ${name}`); }, console});
  return exports.createDocumentWorkspace(files, options);
}

const idFor = path => encodeURIComponent(path);
const text = (workspace, path) => workspace.service.getSnapshot().documents.find(item => item.path === path);

test("reader registration is limited to open documents and unregister is token safe", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  await workspace.service.open("chapter.txt");
  const id = idFor("chapter.txt");
  assert.throws(() => workspace.service.registerContentReader("missing", () => "bad"), /已打开/);
  const removeOld = workspace.service.registerContentReader(id, () => "old");
  const removeCurrent = workspace.service.registerContentReader(id, () => "current");
  removeOld();
  assert.equal(await workspace.service.save(id), true);
  assert.equal(store.disk.get("chapter.txt"), "current");
  removeCurrent();
  assert.equal(await workspace.service.save(id), true);
  assert.equal(store.disk.get("chapter.txt"), "current");
  await workspace.dispose();
});

test("switch, save, saveAll, saveAs, close and leave flush into the shared buffer", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  await workspace.service.open("one.txt");
  const one = idFor("one.txt");
  let oneText = "edited one";
  const removeOne = workspace.service.registerContentReader(one, () => oneText);
  await workspace.service.open("two.txt");
  const two = idFor("two.txt");
  assert.equal(text(workspace, "one.txt").content, oneText, "opening another file flushes the active document before activation");
  assert.equal(workspace.service.select(one), true);
  assert.equal(text(workspace, "one.txt").content, oneText);

  oneText = "source flushed before conversion";
  await workspace.service.saveAs(one, "one-copy.txt", "explicit target text");
  assert.equal(store.disk.get("one-copy.txt"), "explicit target text");
  assert.equal(text(workspace, "one.txt").content, oneText);

  await workspace.service.saveAs(one, "one-copy.lode", "converted envelope");
  assert.equal(store.disk.get("one-copy.lode"), "converted envelope", "saveAs persists the caller's converted target content");
  assert.equal(text(workspace, "one.txt").content, oneText, "saveAs also flushes the source editor into its existing buffer");

  let twoText = "edited two";
  const removeTwo = workspace.service.registerContentReader(two, () => twoText);
  assert.equal(await workspace.service.saveAll(), true);
  assert.equal(store.disk.get("one.txt"), oneText);
  assert.equal(store.disk.get("two.txt"), twoText, "saveAll flushes a registered reader even on an inactive tab");

  oneText = "closed text";
  assert.equal(await workspace.service.close(one), true);
  assert.equal(store.disk.get("one.txt"), oneText);
  removeOne();
  twoText = "leave text";
  assert.equal(await workspace.beforeLeave(), true);
  assert.equal(store.disk.get("two.txt"), twoText);
  removeTwo();
  await workspace.dispose();
});

test("reader errors block switch, save, close, unconfirmed deletion and leave without replacing the buffer", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  await workspace.service.open("one.txt");
  await workspace.service.open("two.txt");
  const one = idFor("one.txt");
  assert.equal(workspace.service.select(one), true);
  const remove = workspace.service.registerContentReader(one, () => { throw new Error("composition still active"); });

  assert.equal(await workspace.service.save(one), false);
  assert.equal(text(workspace, "one.txt").content, "disk:one.txt");
  assert.match(workspace.service.getSnapshot().error, /composition still active/);
  assert.equal(workspace.service.select(idFor("two.txt")), false);
  assert.equal(await workspace.service.close(one), false);
  assert.equal(await workspace.service.deleteDocument("one.txt"), false);
  assert.equal(await workspace.beforeLeave(), false);
  assert.equal(text(workspace, "one.txt").content, "disk:one.txt");
  assert.equal(store.calls.some(([operation]) => operation === "save"), false);
  assert.equal(store.calls.some(([operation]) => operation === "delete"), false);

  remove();
  assert.equal(await workspace.service.deleteDocument("one.txt", {discardChanges: true}), true);
  await workspace.dispose();
});

test("dispose flushes before unmount and retains the original buffer when a reader fails", async () => {
  const store = createFilesStore();
  const workspace = createWorkspace(store.files);
  await workspace.service.open("chapter.txt");
  workspace.service.registerContentReader(idFor("chapter.txt"), () => { throw new Error("cannot flush"); });
  let failure;
  try { await workspace.dispose(); } catch (cause) { failure = cause; }
  assert.ok(failure);
  assert.equal(failure.snapshot.documents[0].content, "disk:chapter.txt");
  assert.match(failure.snapshot.error, /cannot flush/);
  assert.equal(store.calls.some(([operation]) => operation === "save"), false);
});
