import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function createFixture() {
  const modules = new Map();
  const diskByProject = new Map();
  const stores = new Map();
  const logs = [];
  const controls = {failWrites: false, rejectReveal: false, createGate: null};
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
  const encode = value => Array.from(encoder.encode(value));
  const decode = value => decoder.decode(Uint8Array.from(value));
  const sameBytes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  const documentsKey = Object.freeze({id: "app/documents"});
  const documentRevealRequested = Object.freeze({id: "app/documents/reveal-requested"});
  const workbenchKey = Object.freeze({id: "app/workbench"});
  const projectStorageKey = Object.freeze({id: "app/project-storage"});
  const shortcutsKey = Object.freeze({id: "app/shortcuts"});
  const shortcutCommandIds = Object.freeze({
    saveAll: "documents.saveAll", closeDocument: "documents.close", projectSearch: "project-search.open",
    newDocument: "project-management.newDocument", renameEntry: "project-management.rename",
  });
  const shortcutScopeIds = Object.freeze({application: "application", workbench: "workbench", document: "document", projectTree: "project-tree"});
  const commands = new Map();
  const bindings = new Map();
  const scopes = new Map();
  const shortcuts = {
    registerCommand(command) {
      if (commands.has(command.id)) throw new Error(`Duplicate command '${command.id}'.`);
      commands.set(command.id, command);
      return () => { if (commands.get(command.id) === command) commands.delete(command.id); };
    },
    registerBinding(binding) {
      if (bindings.has(binding.id)) throw new Error(`Duplicate binding '${binding.id}'.`);
      bindings.set(binding.id, binding);
      return () => { if (bindings.get(binding.id) === binding) bindings.delete(binding.id); };
    },
    registerScope(scope) { scopes.set(scope.id, scope); return () => scopes.delete(scope.id); },
    async execute(id, args) {
      const command = commands.get(id);
      const invocation = {source: "ui", target: null, args};
      if (!command || command.enabled && !command.enabled(invocation)) return false;
      await command.run(invocation);
      return true;
    },
    getShortcut() { return undefined; },
    getSnapshot() { return {commands: [], bindings: [], conflicts: []}; },
    subscribe() { return () => {}; },
    async setBinding() {},
    async resetBinding() {},
  };

  function resolveModule(fromPath, specifier) {
    const base = resolve(dirname(fromPath), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
      try { readFileSync(candidate, "utf8"); return candidate; }
      catch { /* try the next extension */ }
    }
    throw new Error(`Cannot resolve '${specifier}' from '${fromPath}'.`);
  }

  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      console: {error(...args) { logs.push(args); }},
      setTimeout,
      clearTimeout,
      queueMicrotask,
      TextEncoder,
      TextDecoder,
      require(specifier) {
        if (specifier === "@lodestory/sdk/documents") return {documentsKey, documentRevealRequested};
        if (specifier === "@lodestory/sdk/project-storage") return {projectStorageKey};
        if (specifier === "@lodestory/sdk/workbench") return {workbenchKey};
        if (specifier === "@lodestory/sdk/shortcuts") return {shortcutsKey, shortcutCommandIds, shortcutScopeIds};
        return load(resolveModule(path, specifier));
      },
    }, { filename: path });
    return exports;
  }

  let state = {session: null, busy: true, active: false};
  const subscribers = new Set();
  const participants = new Map();
  const participationBySession = new Map();
  const workbench = {
    getSnapshot() { return state; },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    registerParticipant(participant) {
      if (participants.has(participant.id)) throw new Error(`Duplicate participant '${participant.id}'.`);
      participants.set(participant.id, participant);
      return async () => {
        participants.delete(participant.id);
        for (const [id, participation] of [...participationBySession]) {
          await participation.dispose();
          participationBySession.delete(id);
        }
      };
    },
  };
  function setWorkbench(next) {
    state = next;
    for (const listener of [...subscribers]) listener();
  }

  function storageFor(sessionId) {
    if (stores.has(sessionId)) return stores.get(sessionId);
    const projectPath = state.session?.id === sessionId ? state.session.project.path : null;
    if (!projectPath) throw new Error(`No active session for '${sessionId}'.`);
    const disk = diskByProject.get(projectPath) ?? new Map();
    diskByProject.set(projectPath, disk);
    const buffers = new Map();
    const listeners = new Set();
    const calls = [];
    let error = null;
    const blocked = () => state.busy || state.session?.id !== sessionId;
    let snapshot = Object.freeze({files: Object.freeze([]), blocked: blocked(), error});
    const freeze = file => Object.freeze({...file, bytes: Object.freeze([...file.bytes])});
    const publish = () => {
      snapshot = Object.freeze({files: Object.freeze([...buffers.values()].map(item => item.file)), blocked: blocked(), error});
      for (const listener of [...listeners]) listener();
    };
    function install(path, bytes, savedBytes = bytes, saveState = "saved", saveError = null) {
      const file = freeze({path, fileName: path.split("/").at(-1), bytes,
        dirty: !sameBytes(bytes, savedBytes), saveState, saveError});
      buffers.set(path, {file, savedBytes: [...savedBytes]});
      publish();
      return file;
    }
    const files = {
      getSnapshot() { return Object.freeze({...snapshot, blocked: blocked()}); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async read(path) {
        calls.push(["read", path]);
        if (blocked()) { error = "项目正忙"; publish(); return null; }
        const current = buffers.get(path);
        if (current?.file.dirty || current?.file.saveState === "saving") return current.file;
        error = null;
        return install(path, disk.get(path) ?? encode(`content:${path}`));
      },
      async create(path, bytes) {
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const name = path.split("/").at(-1);
        const content = decode(bytes);
        calls.push(["create", parentPath, name, content]);
        if (blocked()) { error = "项目正忙"; publish(); return null; }
        if (controls.createGate) await controls.createGate;
        if (disk.has(path)) { error = "文件已存在"; publish(); return null; }
        disk.set(path, [...bytes]);
        error = null;
        return install(path, bytes);
      },
      async createDirectory(path) {
        calls.push(["createDirectory", path]);
        if (blocked()) { error = "项目正忙"; publish(); return null; }
        return true;
      },
      write(path, bytes) {
        if (blocked()) return false;
        const current = buffers.get(path);
        if (!current) return false;
        error = null;
        install(path, bytes, current.savedBytes, sameBytes(bytes, current.savedBytes) ? "saved" : "pending");
        return true;
      },
      async save(path) {
        calls.push(["save", path]);
        const current = buffers.get(path);
        if (!current) return false;
        buffers.set(path, {file: freeze({...current.file, saveState: "saving", saveError: null}), savedBytes: current.savedBytes});
        publish();
        await Promise.resolve();
        if (controls.failWrites) {
          buffers.set(path, {file: freeze({...buffers.get(path).file, saveState: "error", saveError: "write failed"}), savedBytes: current.savedBytes});
          error = "write failed";
          publish();
          return false;
        }
        const latest = buffers.get(path).file;
        disk.set(path, [...latest.bytes]);
        buffers.set(path, {file: freeze({...latest, dirty: false, saveState: "saved", saveError: null}), savedBytes: [...latest.bytes]});
        error = null;
        publish();
        return true;
      },
      async saveAll() {
        calls.push(["saveAll"]);
        for (const [path, entry] of buffers) if (entry.file.dirty && !await files.save(path)) return false;
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
        disk.delete(path);
        buffers.delete(path);
        error = null;
        publish();
        return true;
      },
      clearError() { if (error !== null) { error = null; publish(); } },
    };
    const result = {files, calls, disk, putDisk(path, bytes) { disk.set(path, [...bytes]); }};
    stores.set(sessionId, result);
    return result;
  }

  const emitted = [];
  const provided = new Map();
  const context = {
    track: value => value,
    get(key) {
      if (key === workbenchKey) return workbench;
      if (key === projectStorageKey) return {getFiles: sessionId => storageFor(sessionId).files};
      if (key === shortcutsKey) return shortcuts;
      throw new Error(`Unexpected service key: ${key.id}`);
    },
    provide(key, value) { provided.set(key, value); },
    async emit(key, payload) {
      emitted.push([key, payload]);
      if (key === documentRevealRequested && controls.rejectReveal) throw new Error("reveal listener failed");
    },
  };
  const {createDocumentsPlugin} = load(resolve(sourceRoot, "plugins/documents/documentsPlugin.ts"));
  const plugin = createDocumentsPlugin();
  return {
    controls, context, emitted, logs, participants, participationBySession, plugin, provided, encode, decode,
    documentsKey, documentRevealRequested, workbenchKey, projectStorageKey, shortcutsKey, shortcuts,
    shortcutCommandIds, shortcutScopeIds, commands, bindings, scopes, stores,
    setWorkbench, workbench,
    activate() { plugin.activate(context); return provided.get(documentsKey); },
    start(session) {
      setWorkbench({session, busy: true, active: false});
      const participation = participants.get("documents").start(session);
      participationBySession.set(session.id, participation);
      return participation;
    },
  };
}

const projectSession = (id, path) => ({id, project: {id: `project-${id}`, name: id, path}});

test("documents depends on project storage and owns one tab workspace per workbench session", async () => {
  const f = createFixture();
  assert.deepEqual(Array.from(f.plugin.requires), [f.workbenchKey, f.projectStorageKey, f.shortcutsKey]);
  assert.deepEqual(Array.from(f.plugin.provides), [f.documentsKey]);
  const documents = f.activate();
  assert.equal(documents.getWorkspace("session-a"), null);

  const firstSession = projectSession("session-a", "/projects/first");
  const firstParticipation = f.start(firstSession);
  const first = documents.getWorkspace(firstSession.id);
  assert.ok(first);
  assert.equal(documents.getWorkspace(firstSession.id), first);
  assert.equal(first.getSnapshot().blocked, true);
  assert.throws(() => f.participants.get("documents").start(firstSession), /cannot be started/i);

  f.setWorkbench({session: firstSession, busy: false, active: true});
  assert.equal(first.getSnapshot().blocked, false);
  const firstDocument = await first.create("", "第一章");
  assert.equal(firstDocument.path, "第一章.md");
  assert.equal(f.stores.get(firstSession.id).calls[0][0], "create");

  const secondSession = projectSession("session-b", "/projects/second");
  f.setWorkbench({session: secondSession, busy: false, active: true});
  const secondParticipation = f.start(secondSession);
  const second = documents.getWorkspace(secondSession.id);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.getSnapshot().blocked, true, "new project sessions start staged");
  f.setWorkbench({session: secondSession, busy: false, active: true});
  await second.open("第一章.md");
  assert.equal(first.getSnapshot().documents[0].content, "");
  assert.equal(second.getSnapshot().documents[0].content, "content:第一章.md");

  await firstParticipation.dispose();
  f.participationBySession.delete(firstSession.id);
  assert.equal(documents.getWorkspace(firstSession.id), null);
  assert.equal(await first.open("旧会话.md"), false);
  assert.equal(second.getSnapshot().documents.length, 1);
  await secondParticipation.dispose();
  f.participationBySession.delete(secondSession.id);
  assert.equal(documents.getWorkspace(secondSession.id), null);
  await f.plugin.deactivate();
});

test("save and close commands reject unavailable work and stale sessions", async () => {
  const f = createFixture();
  const documents = f.activate();
  const firstSession = projectSession("shortcut-a", "/projects/shortcut-a");
  const firstParticipation = f.start(firstSession);
  f.setWorkbench({session: firstSession, busy: false, active: true});
  const first = documents.getWorkspace(firstSession.id);
  const firstDocument = await first.create("", "第一章");
  assert.equal(first.update(firstDocument.id, "待保存内容"), true);

  const save = f.commands.get(f.shortcutCommandIds.saveAll);
  const close = f.commands.get(f.shortcutCommandIds.closeDocument);
  assert.ok(save);
  assert.ok(close);
  assert.equal(f.bindings.get("documents.saveAll.default").keys, "Mod+S");
  assert.equal(f.bindings.get("documents.close.default").keys, "Mod+W");
  assert.equal(save.enabled({source: "keyboard", target: null}), true);
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.saveAll), true);
  assert.equal(f.stores.get(firstSession.id).calls.some(([operation]) => operation === "save"), true);
  assert.equal(first.getSnapshot().documents[0].saveState, "saved");

  assert.equal(close.enabled({source: "keyboard", target: null}), true);
  f.setWorkbench({session: firstSession, busy: true, active: true});
  assert.equal(save.enabled({source: "keyboard", target: null}), false);
  assert.equal(close.enabled({source: "keyboard", target: null}), false);

  const secondSession = projectSession("shortcut-b", "/projects/shortcut-b");
  f.setWorkbench({session: secondSession, busy: false, active: true});
  const secondParticipation = f.start(secondSession);
  f.setWorkbench({session: secondSession, busy: false, active: true});
  const second = documents.getWorkspace(secondSession.id);
  const secondDocument = await second.create("", "第二章");
  assert.equal(second.update(secondDocument.id, "当前会话内容"), true);
  const firstSaveCount = f.stores.get(firstSession.id).calls.filter(([operation]) => operation === "save").length;
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.saveAll, {sessionId: firstSession.id}), false);
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.closeDocument, {sessionId: firstSession.id, documentId: firstDocument.id}), false);
  assert.equal(f.stores.get(firstSession.id).calls.filter(([operation]) => operation === "save").length, firstSaveCount);
  assert.equal(first.getSnapshot().documents.length, 1, "a stale shortcut cannot close a previous session's document");
  assert.equal(second.getSnapshot().documents.length, 1);

  await firstParticipation.dispose();
  await secondParticipation.dispose();
  await f.plugin.deactivate();
  assert.equal(f.commands.has(f.shortcutCommandIds.saveAll), false, "deactivation unregisters contributed commands");
  assert.equal(f.bindings.has("documents.close.default"), false, "deactivation unregisters default bindings");
});

test("close shortcut keeps a document open when its save fails", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("shortcut-close", "/projects/shortcut-close");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  const document = await workspace.create("", "保留内容");
  assert.equal(workspace.update(document.id, "尚未保存"), true);
  f.controls.failWrites = true;

  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.closeDocument, {documentId: document.id}), true);
  const retained = workspace.getSnapshot().documents[0];
  assert.equal(retained.id, document.id);
  assert.equal(retained.content, "尚未保存");
  assert.equal(retained.saveState, "error");

  f.controls.failWrites = false;
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.closeDocument, {documentId: document.id}), true);
  assert.equal(workspace.getSnapshot().documents.length, 0);

  await participation.dispose();
  await f.plugin.deactivate();
});

test("storage snapshots update open document views, while closing a tab keeps its shared buffer", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("session-a", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  const created = await workspace.create("", "第一章");
  assert.equal(workspace.getSnapshot().documents[0].path, "第一章.md");
  assert.equal(workspace.update(created.id, "草稿来自同一缓冲"), true);
  const store = f.stores.get(session.id);
  assert.equal(f.decode(store.files.getSnapshot().files[0].bytes), "草稿来自同一缓冲");

  assert.equal(await workspace.close(created.id), true);
  assert.equal(workspace.getSnapshot().documents.length, 0);
  assert.equal(store.files.getSnapshot().files.length, 1);
  assert.equal(await workspace.open(created.path), true);
  assert.equal(workspace.getSnapshot().documents[0].content, "草稿来自同一缓冲");
  assert.equal(store.calls.filter(([operation]) => operation === "read").length, 1);
  assert.equal(typeof documents.getResources, "undefined", "resource persistence is no longer part of DocumentsService");

  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("the text adapter preserves BOM bytes and ignores unrelated binary buffers", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("session-bytes", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  const store = f.stores.get(session.id);
  const bomBytes = [0xef, 0xbb, 0xbf, ...f.encode("正文")];
  store.putDisk("序章.md", bomBytes);
  store.putDisk("封面.bin", [0xff, 0x00, 0x81]);

  await store.files.read("封面.bin");
  const opened = await workspace.open("序章.md");
  assert.equal(opened, true);
  const document = workspace.getSnapshot().documents[0];
  assert.equal(document.content, "\uFEFF正文", "UTF-8 decoding keeps the leading BOM as text");
  assert.equal(workspace.getSnapshot().documents.length, 1, "the unrelated binary buffer is not decoded by documents");
  assert.equal(await workspace.save(document.id), true);
  assert.deepEqual(store.disk.get("序章.md"), bomBytes, "saving without edits keeps the original BOM bytes");
  assert.equal(workspace.update(document.id, document.content), true);
  assert.equal(await workspace.save(document.id), true);
  assert.deepEqual(store.disk.get("序章.md"), bomBytes, "editing and saving the BOM-preserving text round-trips the same bytes");

  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("invalid UTF-8 is rejected without replacing or saving the original bytes", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("session-invalid-utf8", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  const store = f.stores.get(session.id);
  const invalidBytes = [0x66, 0xff, 0x6f];
  store.putDisk("损坏.md", invalidBytes);

  assert.equal(await workspace.open("损坏.md"), false);
  assert.match(workspace.getSnapshot().error, /UTF-8/);
  assert.deepEqual(store.disk.get("损坏.md"), invalidBytes);
  assert.equal(workspace.getSnapshot().documents.length, 0);
  assert.equal(store.calls.some(([operation]) => operation === "create" || operation === "save"), false);

  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("accepted creates start storage synchronously and are drained before leaving", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("session-pending", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  let finishCreate;
  f.controls.createGate = new Promise(resolve => { finishCreate = resolve; });

  const creating = workspace.create("卷一", "新章");
  assert.deepEqual(f.stores.get(session.id).calls[0], ["create", "卷一", "新章.md", ""]);
  f.setWorkbench({session, busy: true, active: true});
  const leaving = participation.beforeLeave();
  assert.equal(await workspace.create("", "不应接受"), null);
  f.controls.createGate = null;
  finishCreate();
  assert.equal((await creating).path, "卷一/新章.md");
  assert.equal(await leaving, true);
  assert.deepEqual(Array.from(workspace.getSnapshot().documents, document => document.path), ["卷一/新章.md"]);

  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("reveal events and save failures preserve the shared document buffer", async () => {
  const f = createFixture();
  f.controls.rejectReveal = true;
  const documents = f.activate();
  const session = projectSession("session-a", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);

  const created = await workspace.create("", "第一章");
  assert.equal(created.path, "第一章.md");
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0][0], f.documentRevealRequested);
  assert.deepEqual({...f.emitted[0][1]}, {sessionId: session.id, documentId: created.id});

  workspace.update(created.id, "未保存内容");
  f.controls.failWrites = true;
  assert.equal(await workspace.save(created.id), false);
  assert.equal(workspace.getSnapshot().documents[0].content, "未保存内容");
  assert.equal(workspace.getSnapshot().documents[0].saveError, "write failed");
  await Promise.resolve();
  assert.ok(f.logs.length >= 2, "reveal errors are reported without escaping the operation");

  f.controls.failWrites = false;
  assert.equal(await workspace.save(created.id), true);
  const second = await workspace.create("", "第二章");
  assert.equal(workspace.select(created.id), true);
  const activeId = workspace.getSnapshot().activeId;
  let finishCreate;
  f.controls.createGate = new Promise(resolve => { finishCreate = resolve; });
  const saveAs = workspace.saveAs(created.id, "第一章.lode", "rich-delta-envelope");
  assert.deepEqual(f.stores.get(session.id).calls.at(-1), ["create", "", "第一章.lode", "rich-delta-envelope"]);
  f.controls.createGate = null;
  assert.equal(workspace.select(second.id), true);
  finishCreate();
  await saveAs;

  const snapshot = workspace.getSnapshot();
  assert.equal(snapshot.documents.find(document => document.fileName === "第一章.lode").content, "rich-delta-envelope");
  assert.equal(snapshot.activeId, second.id, "a late create does not steal the current selection");
  assert.equal(snapshot.documents.find(document => document.id === created.id).content, "未保存内容");
  await assert.rejects(workspace.saveAs(created.id, "第一章.lode", "replacement"), /已在工作区打开/);
  assert.equal(activeId, created.id);
  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("a failed dispose exposes a recoverable tab snapshot and deactivation invalidates handles", async () => {
  const f = createFixture();
  const documents = f.activate();
  const session = projectSession("session-a", "/projects/book");
  const participation = f.start(session);
  f.setWorkbench({session, busy: false, active: true});
  const workspace = documents.getWorkspace(session.id);
  const document = await workspace.create("", "草稿");
  workspace.update(document.id, "不能丢失的草稿");
  f.controls.failWrites = true;
  let failure;
  await assert.rejects(participation.dispose(), cause => { failure = cause; return /could not be saved/i.test(cause.message); });
  assert.equal(failure.snapshot.documents[0].content, "不能丢失的草稿");
  assert.equal(workspace.getSnapshot(), failure.snapshot, "the failed lifecycle exposes its terminal recovery snapshot");

  f.controls.failWrites = false;
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
  assert.equal(documents.getWorkspace(session.id), null);
  assert.equal(await workspace.open("迟到打开.md"), false);
});
