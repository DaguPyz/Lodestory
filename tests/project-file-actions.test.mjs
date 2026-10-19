import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

async function fixture() {
  let entries = [{path: "chapters", name: "chapters", children: [
    {path: "chapters/old.md", name: "old.md"},
  ]}];
  let state = {documents: [], activeId: null, blocked: false, creating: false,
    deletingPath: null, openingPath: null, error: null};
  const calls = {documents: [], directories: [], deletes: []};
  const subscribers = new Set();
  let deleteHandler = async () => true;
  const workspace = {
    getSnapshot: () => state,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    clearError() { state = {...state, error: null}; },
    async open() { return true; },
    async create(parent, name) {
      calls.documents.push([parent, name]);
      const path = parent ? `${parent}/${name}` : name;
      if (parent === "chapters") entries[0].children.push({path, name});
      else entries.push({path, name});
      return {id: path, path};
    },
    async createDirectory(parent, name) {
      calls.directories.push([parent, name]);
      const path = parent ? `${parent}/${name}` : name;
      const directory = {path, name, children: []};
      if (parent === "chapters") entries[0].children.push(directory);
      else entries.push(directory);
      return path;
    },
    async deleteDocument(path, options) {
      calls.deletes.push([path, options.discardChanges]);
      const removed = await deleteHandler(path);
      if (removed) entries[0].children = entries[0].children.filter(entry => entry.path !== path);
      return removed;
    },
  };
  const session = {id: "project-session", project: {path: "/project", name: "小说"}};
  const workbench = {
    getSnapshot: () => ({session, active: true, busy: false}),
    subscribe() { return () => {}; },
  };
  const module = {exports: {}};
  const source = readFileSync(new URL("../src/plugins/project-management/projectManagementModel.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(compiled, {exports: module.exports, module, console, require(specifier) {
    if (specifier === "@tauri-apps/api/core") return {isTauri: () => true};
    if (specifier === "./projectFilesApi") return {
      async listDocuments() { return structuredClone(entries); },
      projectFilesErrorMessage: error => error.message,
    };
    throw new Error(`Unexpected import ${specifier}`);
  }});
  const model = module.exports.createProjectManagementModel(session, workbench, workspace);
  await model.refresh();
  return {model, calls, setDelete(handler) { deleteHandler = handler; },
    setError(error) { state = {...state, error}; }};
}

test("default creation remains unchanged and quick creation selects the requested format", async () => {
  const {model, calls} = await fixture();
  assert.equal(model.requestCreate("chapters"), true);
  await model.create("chapters", "默认文档");
  assert.deepEqual(calls.documents[0], ["chapters", "默认文档"]);
  for (const extension of ["txt", "md", "lode"]) {
    assert.equal(model.requestCreate("chapters", extension), true);
    assert.equal(model.getSnapshot().createExtension, extension);
    await model.create("chapters", "新章节.markdown");
    assert.deepEqual(calls.documents.at(-1), ["chapters", `新章节.${extension}`]);
    assert.equal(model.getSnapshot().dialogOpen, false);
  }
  model.dispose();
});

test("folder creation delegates to the directory capability without creating a document", async () => {
  const {model, calls} = await fixture();
  const visibleKinds = [];
  model.subscribe(() => {
    const snapshot = model.getSnapshot();
    if (snapshot.dialogOpen) visibleKinds.push(snapshot.createKind);
  });
  assert.equal(model.requestCreateDirectory("chapters"), true);
  assert.equal(model.getSnapshot().createKind, "directory");
  assert.equal(model.getSnapshot().createExtension, null);
  assert.ok(visibleKinds.every(kind => kind === "directory"), "subscribers never see a document dialog for folder creation");
  await model.create("chapters", "人物");
  assert.deepEqual(calls.directories, [["chapters", "人物"]]);
  assert.deepEqual(calls.documents, []);
  assert.equal(model.getSnapshot().entries[0].children.at(-1).path, "chapters/人物");
  assert.equal(model.getSnapshot().dialogOpen, false);
  model.dispose();
});

test("delete requests only show confirmation and cancellation does not touch the file", async () => {
  const {model, calls} = await fixture();
  assert.equal(model.requestDelete("chapters"), false, "folders cannot be deleted by the document action");
  assert.equal(model.requestDelete("missing.md"), false);
  assert.equal(model.requestDelete("chapters/old.md"), true);
  assert.equal(model.getSnapshot().deletePath, "chapters/old.md");
  assert.deepEqual(calls.deletes, []);
  assert.equal(model.closeDeleteDialog(), true);
  assert.deepEqual(calls.deletes, []);
  assert.equal(model.getSnapshot().deletePath, null);
  model.dispose();
});

test("confirmed deletion is single-flight, passes discard consent and refreshes the tree", async () => {
  const {model, calls, setDelete} = await fixture();
  let finish;
  setDelete(() => new Promise(resolve => { finish = resolve; }));
  model.requestDelete("chapters/old.md");
  const pending = model.confirmDelete();
  assert.equal(model.getSnapshot().deleting, true);
  assert.equal(model.closeDeleteDialog(), false);
  assert.equal(model.requestCreateDirectory(""), false);
  await model.confirmDelete();
  assert.deepEqual(calls.deletes, [["chapters/old.md", true]]);
  finish(true);
  await pending;
  assert.equal(model.getSnapshot().deletePath, null);
  assert.equal(model.getSnapshot().deleting, false);
  assert.equal(model.getSnapshot().entries[0].children.length, 0);
  model.dispose();
});

test("failed deletion keeps the confirmation and tree entry available for retry", async () => {
  const {model, calls, setDelete, setError} = await fixture();
  setDelete(async () => { setError("磁盘文件已变化"); return false; });
  model.requestDelete("chapters/old.md");
  await model.confirmDelete();
  assert.equal(model.getSnapshot().deleteError, "磁盘文件已变化");
  assert.equal(model.getSnapshot().deletePath, "chapters/old.md");
  assert.equal(model.getSnapshot().deleting, false);
  assert.equal(model.getSnapshot().entries[0].children[0].path, "chapters/old.md");
  setDelete(async () => true);
  await model.confirmDelete();
  assert.equal(calls.deletes.length, 2);
  assert.equal(model.getSnapshot().deletePath, null);
  model.dispose();
});
