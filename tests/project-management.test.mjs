import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

function entries(names) {
  const root = [];
  for (const path of names) {
    const parts = path.split("/");
    let children = root;
    for (let index = 0; index < parts.length; index += 1) {
      const currentPath = parts.slice(0, index + 1).join("/");
      let entry = children.find(item => item.path === currentPath);
      if (!entry) {
        entry = {path: currentPath, name: parts[index]};
        children.push(entry);
      }
      if (index < parts.length - 1) {
        entry.children ??= [];
        children = entry.children;
      }
    }
  }
  return root;
}

function entryPaths(tree) {
  return tree.flatMap(entry => [entry.path, ...entryPaths(entry.children ?? [])]);
}

function createFixture({listDocuments = async () => [], desktop = true} = {}) {
  const modules = new Map();
  const listCalls = [];
  const openCalls = [];
  const createCalls = [];
  const workbenchListeners = new Set();
  const workspaceListeners = new Set();
  const session = {id: "session-a", project: {id: "project-a", name: "第一本", path: "/projects/first"}};
  let workbenchSnapshot = {session, active: true, busy: false};
  let workspaceSnapshot = {
    documents: [], activeId: null, openingPath: null, creating: false, deletingPath: null, blocked: false, error: null,
  };
  const controls = {open: undefined, create: undefined};

  function publishWorkspace(next) {
    workspaceSnapshot = Object.freeze({...workspaceSnapshot, ...next});
    for (const listener of [...workspaceListeners]) listener();
  }

  const workspace = {
    getSnapshot() { return workspaceSnapshot; },
    subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
    async open(path) {
      openCalls.push(path);
      if (controls.open) return controls.open(path);
      const document = Object.freeze({id: `opaque:${path}`, path, fileName: path.split("/").at(-1), content: "正文", saveState: "saved", saveError: null});
      publishWorkspace({documents: [...workspaceSnapshot.documents.filter(item => item.id !== document.id), document], activeId: document.id, openingPath: null});
      return true;
    },
    async create(parentPath, name) {
      createCalls.push([parentPath, name]);
      if (controls.create) return controls.create(parentPath, name);
      const path = [parentPath, name].filter(Boolean).join("/");
      const document = Object.freeze({id: `opaque:${path}`, path, fileName: name, content: "", saveState: "saved", saveError: null});
      publishWorkspace({documents: [...workspaceSnapshot.documents.filter(item => item.id !== document.id), document], activeId: document.id, creating: false});
      return document;
    },
    async createDirectory() { throw new Error("Unexpected directory creation in this fixture"); },
    async deleteDocument() { throw new Error("Unexpected document deletion in this fixture"); },
    clearError() { publishWorkspace({error: null}); },
  };

  function resolveModule(fromPath, specifier) {
    const base = resolve(dirname(fromPath), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
      try { readFileSync(candidate, "utf8"); return candidate; } catch { /* try the next extension */ }
    }
    throw new Error(`Cannot resolve '${specifier}' from '${fromPath}'.`);
  }

  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      Promise,
      Error,
      TypeError,
      Object,
      Array,
      Map,
      Set,
      console,
      require(specifier) {
        if (specifier === "./projectFilesApi") return {
          async listDocuments(projectPath) {
            listCalls.push(projectPath);
            return listDocuments(projectPath, listCalls.length - 1);
          },
          projectFilesErrorMessage(error) { return error instanceof Error ? error.message : String(error); },
        };
        if (specifier === "@tauri-apps/api/core") return {isTauri: () => desktop};
        return load(resolveModule(path, specifier));
      },
    }, {filename: path});
    return exports;
  }

  const workbench = {
    getSnapshot() { return workbenchSnapshot; },
    subscribe(listener) { workbenchListeners.add(listener); return () => workbenchListeners.delete(listener); },
  };
  const {createProjectManagementModel} = load(resolve(sourceRoot, "plugins/project-management/projectManagementModel.ts"));
  const model = createProjectManagementModel(session, workbench, workspace);

  return {
    controls,
    createCalls,
    listCalls,
    model,
    openCalls,
    publishWorkspace,
    session,
    setWorkbench(next) {
      workbenchSnapshot = Object.freeze({...workbenchSnapshot, ...next});
      for (const listener of [...workbenchListeners]) listener();
    },
    workspace,
    workspaceSnapshot: () => workspaceSnapshot,
  };
}

test("the project model reports directory failures and can recover through refresh", async () => {
  let attempts = 0;
  const f = createFixture({listDocuments: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("目录读取失败");
    return entries(["chapters/one.md"]);
  }});
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(f.model.getSnapshot().loading, false);
  assert.equal(f.model.getSnapshot().error, "目录读取失败");
  await f.model.refresh();
  assert.equal(f.model.getSnapshot().error, null);
  assert.deepEqual(entryPaths(f.model.getSnapshot().entries), ["chapters", "chapters/one.md"]);
  assert.equal(attempts, 2);
  f.model.dispose();
});

test("overlapping directory reads publish only the newest result", async () => {
  const older = deferred();
  const newest = deferred();
  let call = 0;
  const f = createFixture({listDocuments: () => (++call === 1 ? older.promise : newest.promise)});
  await Promise.resolve();
  assert.equal(call, 1, "the constructor's initial read should have started");
  const refresh = f.model.refresh();
  newest.resolve(entries(["fresh.md"]));
  await refresh;
  older.resolve(entries(["stale.md"]));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(Array.from(f.model.getSnapshot().entries, entry => entry.path), ["fresh.md"]);
  assert.equal(f.model.getSnapshot().loading, false);
  f.model.dispose();
});

test("document reconciliation uses the document path and treats IDs as opaque", async () => {
  const f = createFixture({listDocuments: async () => entries(["chapters/one.md"])});
  await new Promise(resolve => setImmediate(resolve));
  const id = "opaque::/%not-a-path";
  const document = Object.freeze({id, path: "chapters/one.md", fileName: "one.md", content: "正文", saveState: "saved", saveError: null});
  f.publishWorkspace({documents: [document], activeId: id});
  f.model.reconcileDocument(id);

  assert.equal(f.model.getSnapshot().activeDocumentPath, "chapters/one.md");
  assert.equal(f.model.getSnapshot().selectedFolder, "chapters");
  assert.deepEqual(f.listCalls, ["/projects/first"]);
  f.model.dispose();
});

test("an unknown document path triggers a tree refresh without decoding its ID", async () => {
  let reads = 0;
  const f = createFixture({listDocuments: async () => {
    reads += 1;
    return reads === 1 ? [] : entries(["new-folder/created.md"]);
  }});
  await new Promise(resolve => setImmediate(resolve));
  const id = "%not/a/path";
  const document = Object.freeze({id, path: "new-folder/created.md", fileName: "created.md", content: "", saveState: "saved", saveError: null});
  f.publishWorkspace({documents: [document], activeId: id});
  f.model.reconcileDocument(id);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reads, 2);
  assert.equal(f.model.getSnapshot().activeDocumentPath, "new-folder/created.md");
  assert.equal(f.model.getSnapshot().selectedFolder, "new-folder");
  f.model.dispose();
});

test("a create accepted before workbench leave completes and refreshes the project tree", async () => {
  const create = deferred();
  let reads = 0;
  const f = createFixture({listDocuments: async () => {
    reads += 1;
    return reads === 1 ? entries(["chapters/old.md"]) : entries(["chapters/old.md", "chapters/new.md"]);
  }});
  await new Promise(resolve => setImmediate(resolve));
  f.controls.create = async () => {
    f.publishWorkspace({creating: true});
    const document = await create.promise;
    f.publishWorkspace({documents: [...f.workspaceSnapshot().documents, document], activeId: document.id, creating: false});
    return document;
  };
  f.model.requestCreate("chapters");
  const creating = f.model.create("chapters", "new.md");
  assert.equal(f.model.getSnapshot().creating, true);
  f.setWorkbench({busy: true, active: false});
  f.publishWorkspace({blocked: true, creating: true});
  const document = Object.freeze({id: "opaque/new", path: "chapters/new.md", fileName: "new.md", content: "", saveState: "saved", saveError: null});
  create.resolve(document);
  await creating;

  assert.deepEqual(f.createCalls, [["chapters", "new.md"]]);
  assert.equal(f.model.getSnapshot().creating, false);
  assert.equal(f.model.getSnapshot().activeDocumentPath, "chapters/new.md");
  assert.deepEqual(entryPaths(f.model.getSnapshot().entries), ["chapters", "chapters/old.md", "chapters/new.md"]);
  assert.equal(f.model.getSnapshot().dialogOpen, false);
  f.model.dispose();
});

test("a failed create keeps the dialog and error for retry, then closes after success", async () => {
  let reads = 0;
  const f = createFixture({listDocuments: async () => ++reads === 1 ? [] : entries(["retry.md"])});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.model.requestCreate(""), true);
  let attempts = 0;
  f.controls.create = async (_parentPath, name) => {
    attempts += 1;
    if (attempts === 1) {
      f.publishWorkspace({creating: false, error: "没有写入权限"});
      return null;
    }
    const document = Object.freeze({id: "opaque:retry", path: name, fileName: name, content: "", saveState: "saved", saveError: null});
    f.publishWorkspace({documents: [document], activeId: document.id, creating: false});
    return document;
  };

  await f.model.create("", "retry.md");
  assert.equal(f.model.getSnapshot().dialogOpen, true);
  assert.equal(f.model.getSnapshot().createError, "没有写入权限");
  assert.equal(f.workspaceSnapshot().error, "没有写入权限");

  await f.model.create("", "retry.md");
  assert.equal(f.model.getSnapshot().dialogOpen, false);
  assert.equal(f.model.getSnapshot().createError, null);
  assert.equal(f.workspaceSnapshot().error, null, "retry clears the previous workspace error before creating again");
  assert.deepEqual(f.createCalls, [["", "retry.md"], ["", "retry.md"]]);
  assert.equal(reads, 2, "the project tree is refreshed after the retry succeeds");
  assert.deepEqual(entryPaths(f.model.getSnapshot().entries), ["retry.md"]);
  f.model.dispose();
});

test("a denied project leave keeps the create dialog open and blocks operations until the guard clears", async () => {
  const f = createFixture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.model.requestCreate(""), true);
  f.controls.create = async () => {
    f.publishWorkspace({error: "没有写入权限", creating: false});
    return null;
  };
  await f.model.create("", "first-attempt.md");
  assert.equal(f.model.getSnapshot().createError, "没有写入权限");
  f.setWorkbench({busy: true, active: true});
  f.publishWorkspace({blocked: true});

  assert.equal(f.model.getSnapshot().dialogOpen, true);
  assert.equal(f.model.getSnapshot().blocked, true);
  await f.model.create("", "blocked.md");
  assert.equal(f.model.closeCreateDialog(), false);
  assert.deepEqual(f.createCalls, [["", "first-attempt.md"]], "busy blocks a second submission");
  assert.equal(f.model.getSnapshot().dialogOpen, true);

  f.setWorkbench({busy: false, active: true});
  f.publishWorkspace({blocked: false});
  assert.equal(f.model.getSnapshot().blocked, false);
  assert.equal(f.model.getSnapshot().dialogOpen, true);
  assert.equal(f.model.closeCreateDialog(), true);
  assert.equal(f.model.getSnapshot().dialogOpen, false);
  assert.equal(f.model.getSnapshot().createError, null);
  assert.equal(f.workspaceSnapshot().error, null, "closing clears the failed creation error");
  f.model.dispose();
});

test("disposed session models ignore late tree results and release subscriptions", async () => {
  const pending = deferred();
  const f = createFixture({listDocuments: () => pending.promise});
  let notifications = 0;
  const unsubscribe = f.model.subscribe(() => notifications++);
  const before = f.model.getSnapshot();
  f.model.dispose();
  const disposedSnapshot = f.model.getSnapshot();
  pending.resolve(entries(["late.md"]));
  await new Promise(resolve => setImmediate(resolve));

  assert.notEqual(disposedSnapshot, before, "dispose closes the dialog and blocks the stale model");
  assert.equal(f.model.getSnapshot(), disposedSnapshot);
  assert.equal(notifications, 0);
  f.setWorkbench({busy: true});
  assert.equal(notifications, 0);
  unsubscribe();
});
