import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/timeline/timelineListModel.ts", import.meta.url), "utf8");
const filesSource = await readFile(new URL("../src/plugins/timeline/timelineListFiles.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const modelExports = {};
vm.runInNewContext(compiled, {exports: modelExports, crypto: {randomUUID: () => "00000000-0000-4000-8000-000000000099"}, Date, JSON, Object, Array, Number, String, Set, Map, Math});
const {createTimelineListModel, isCanonicalUuid, isUtcRfc3339, validateTimelineFile} = modelExports;
const filesCompiled = ts.transpileModule(filesSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const filesExports = {};
vm.runInNewContext(filesCompiled, {exports: filesExports, TextDecoder, TextEncoder, Uint8Array, Object, Array, Map, Set, Promise, Error});
const {createTimelineListFiles} = filesExports;

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const stamp = "2026-10-23T08:00:00.000Z";

function file(id, patch = {}) {
  return {
    format: "lodestory.timeline-list-entry",
    schemaVersion: 1,
    id,
    title: "时间线",
    summary: "",
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

function timelineFile(id, value, saveState = "saved") {
  return {id, content: JSON.stringify(value), saveState, saveError: null};
}

function timelineFiles(initial = {}) {
  let snapshot = {
    files: [], issues: [], loaded: false, loading: false, creating: false,
    deletingId: null, blocked: false, error: null, ...initial,
  };
  const listeners = new Set();
  const calls = {created: [], deleted: [], saved: [], loads: 0};
  const api = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(next) { snapshot = {...snapshot, ...next}; for (const listener of [...listeners]) listener(); },
    async load() { calls.loads++; api.emit({loading: true}); api.emit({loading: false, loaded: true, error: null}); return true; },
    async create(id, content) { calls.created.push({id, content}); return null; },
    update() { return true; },
    async save(id) { calls.saved.push(id); return true; },
    async saveAll() { return true; },
    async delete(id) { calls.deleted.push(id); return true; },
    clearError() { api.emit({error: null}); },
    dispose() {},
    calls,
  };
  return api;
}

function modelFor(api, options = {}) {
  return createTimelineListModel(api, {createId: () => ids[2], now: () => stamp, ...options});
}

test("timeline files validate exact fields, Unicode code points, canonical IDs, and UTC timestamps", () => {
  assert.equal(isCanonicalUuid(ids[0]), true);
  assert.equal(isCanonicalUuid("00000000-0000-4000-8000-00000000000A"), false, "canonical UUID text is lowercase");
  assert.equal(isUtcRfc3339(stamp), true);
  assert.equal(isUtcRfc3339("2026-02-29T08:00:00Z"), false);
  assert.equal(isUtcRfc3339("2026-10-23T08:00:00+00:00"), false, "UTC timestamps use Z");

  const astralTitle = "😀".repeat(60);
  assert.ok(validateTimelineFile(file(ids[0], {title: astralTitle})).entry, "60 Unicode code points fit even though maxlength would count 120 UTF-16 units");
  assert.match(validateTimelineFile(file(ids[0], {title: "😀".repeat(61)})).error, /60/);
  assert.match(validateTimelineFile(file(ids[0], {title: " 名称"})).error, /trim/);
  assert.match(validateTimelineFile(file(ids[0], {summary: "😀".repeat(201)})).error, /200/);
  assert.match(validateTimelineFile(file(ids[0], {id: ids[1]}), ids[0]).error, /文件名/);
  assert.match(validateTimelineFile({...file(ids[0]), eventCount: 0}).error, /字段/);
  assert.ok(validateTimelineFile(file(ids[0])).entry);
});

test("outline byte adapter owns the unchanged hidden path and UTF-8 JSON convention", async () => {
  const directory = ".lodestory/outline-design/timelines";
  const path = `${directory}/${ids[0]}.json`;
  const invalidUtf8Path = `${directory}/${ids[1]}.json`;
  const otherPath = `${directory}/${ids[2]}.json`;
  const toBytes = value => Array.from(new TextEncoder().encode(value));
  let snapshot = {files: [
    {path, fileName: `${ids[0]}.json`, bytes: toBytes(JSON.stringify(file(ids[0]))), dirty: false, saveState: "saved", saveError: null},
    {path: invalidUtf8Path, fileName: `${ids[1]}.json`, bytes: [0xff, 0xfe], dirty: false, saveState: "saved", saveError: null},
    {path: otherPath, fileName: `${ids[2]}.json`, bytes: toBytes("{}"), dirty: false, saveState: "saved", saveError: null},
  ], blocked: false, error: null};
  const listeners = new Set();
  const writes = [];
  let listing = {exists: true, entries: [
    {path, name: `${ids[0]}.json`, kind: "file", size: 1},
    {path: invalidUtf8Path, name: `${ids[1]}.json`, kind: "file", size: 2},
    {path: otherPath, name: `${ids[2]}.json`, kind: "file", size: 1},
    {path: `${directory}/bad.json`, name: "bad.json", kind: "file", size: 1},
    {path: `${directory}/${ids[1]}.json`, name: `${ids[1]}.json`, kind: "symlink", size: 0},
    {path: `${directory}/notes.md`, name: "notes.md", kind: "file", size: 0},
  ], issues: []};
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list(value) { assert.equal(value, directory); return listing; },
    async read(value) { return snapshot.files.find(item => item.path === value) ?? null; },
    async create(value, bytes, options) {
      writes.push({kind: "create", path: value, bytes: Array.from(bytes), options});
      const file = {path: value, fileName: value.split("/").at(-1), bytes: Array.from(bytes), dirty: false, saveState: "saved", saveError: null};
      snapshot = {...snapshot, files: [...snapshot.files, file]};
      for (const listener of [...listeners]) listener();
      return file;
    },
    write() { writes.push({kind: "write"}); return true; },
    async save() { return true; },
    async delete(value) { writes.push({kind: "delete", path: value}); snapshot = {...snapshot, files: snapshot.files.filter(item => item.path !== value)}; return true; },
    async saveAll() { return true; },
    async createDirectory() { throw new Error("outline must create parent directories as part of one file create"); },
    clearError() { snapshot = {...snapshot, error: null}; },
  };
  const adapter = createTimelineListFiles(storage);
  assert.equal(await adapter.load(), true);
  const loaded = adapter.getSnapshot();
  assert.equal(loaded.files.length, 2, "bad UTF-8 remains excluded while a good JSON file is readable");
  assert.equal(loaded.files.find(item => item.id === ids[0]).content, JSON.stringify(file(ids[0])));
  assert.ok(loaded.issues.some(issue => issue.message.includes("UTF-8")));
  assert.ok(loaded.issues.some(issue => issue.message.includes("规范 UUID")));
  assert.ok(loaded.issues.some(issue => issue.message.includes("符号链接")));
  assert.deepEqual(snapshot.files.find(item => item.path === invalidUtf8Path).bytes, [0xff, 0xfe]);
  assert.equal(writes.length, 0, "reading or rejecting malformed bytes never writes them back");

  const content = JSON.stringify(file(ids[1], {title: "新建"}));
  assert.equal((await adapter.create(ids[1], content)).content, content);
  assert.equal(writes[0].kind, "create");
  assert.equal(writes[0].path, invalidUtf8Path);
  assert.deepEqual(writes[0].bytes, toBytes(content));
  assert.equal(writes[0].options.createParents, true);
  assert.equal(writes[0].options.acceptIdentical, true);
  assert.equal(writes.some(write => write.kind === "write"), false);
  assert.equal(await adapter.delete(ids[1]), true);
  assert.equal(writes.at(-1).path, invalidUtf8Path);
  adapter.dispose();
});

test("outline byte adapter distinguishes an absent directory from read failure and retries cleanly", async () => {
  let failed = true;
  const listeners = new Set();
  let snapshot = {files: [], blocked: false, error: null};
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list(path) {
      assert.equal(path, ".lodestory/outline-design/timelines");
      if (failed) throw new Error("目录暂时不可读");
      return {exists: false, entries: [], issues: []};
    },
    async read() { return null; }, async create() { return null; }, write() { return false; },
    async save() { return false; }, async saveAll() { return false; }, async delete() { return false; },
    async createDirectory() { return false; }, clearError() { snapshot = {...snapshot, error: null}; },
  };
  const adapter = createTimelineListFiles(storage);
  assert.equal(await adapter.load(), false);
  assert.equal(adapter.getSnapshot().loaded, false);
  assert.match(adapter.getSnapshot().error, /暂时不可读/);
  failed = false;
  assert.equal(await adapter.load(), true);
  assert.equal(adapter.getSnapshot().loaded, true);
  assert.deepEqual(Array.from(adapter.getSnapshot().files), [], "missing directory is a successfully loaded empty list");
  assert.equal(adapter.getSnapshot().error, null);
  adapter.dispose();
});

test("an unrelated shared-storage error does not leak into the timeline list unless the session is blocked", async () => {
  let snapshot = {files: [], blocked: false, error: null};
  const listeners = new Set();
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list() { return {exists: false, entries: [], issues: []}; },
    async read() { return null; }, async create() { return null; }, write() { return false; },
    async save() { return false; }, async saveAll() { return false; }, async delete() { return false; },
    async createDirectory() { return false; }, clearError() {},
  };
  const adapter = createTimelineListFiles(storage);
  assert.equal(await adapter.load(), true);
  snapshot = {...snapshot, error: "其他时间轴文件读取失败"};
  for (const listener of [...listeners]) listener();
  assert.equal(adapter.getSnapshot().error, null);
  snapshot = {...snapshot, blocked: true, error: "项目存储已阻塞"};
  for (const listener of [...listeners]) listener();
  assert.equal(adapter.getSnapshot().error, "项目存储已阻塞");
  adapter.dispose();
});

test("a single-file read failure keeps bytes already in the shared snapshot", async () => {
  const path = `.lodestory/outline-design/timelines/${ids[0]}.json`;
  const content = JSON.stringify(file(ids[0], {title: "已读取的旧内容"}));
  let snapshot = {files: [{
    path, fileName: `${ids[0]}.json`, bytes: Array.from(new TextEncoder().encode(content)), dirty: false, saveState: "saved", saveError: null,
  }], blocked: false, error: null};
  const listeners = new Set();
  let writes = 0;
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list() { return {exists: true, entries: [{path, name: `${ids[0]}.json`, kind: "file", size: 1}], issues: []}; },
    async read() { snapshot = {...snapshot, error: "暂时无法读取文件"}; return null; },
    async create() { writes++; return null; }, write() { writes++; return false; },
    async save() { return false; }, async saveAll() { return false; }, async delete() { writes++; return false; },
    async createDirectory() { return false; }, clearError() { snapshot = {...snapshot, error: null}; },
  };
  const adapter = createTimelineListFiles(storage);
  assert.equal(await adapter.load(), true, "directory enumeration succeeded despite one failed file read");
  assert.equal(adapter.getSnapshot().files[0].content, content, "the previously shared bytes remain readable");
  assert.ok(adapter.getSnapshot().issues.some(issue => issue.name === path && issue.message.includes("读取失败")));
  assert.equal(writes, 0, "a read failure does not rewrite cached or disk bytes");
  adapter.dispose();
});

test("a delete accepted before its UI notification is awaited by project leave", async () => {
  const path = `.lodestory/outline-design/timelines/${ids[0]}.json`;
  const content = JSON.stringify(file(ids[0]));
  const storedFile = {
    path, fileName: `${ids[0]}.json`, bytes: Array.from(new TextEncoder().encode(content)),
    dirty: false, saveState: "saved", saveError: null,
  };
  let snapshot = {files: [storedFile], blocked: false, error: null};
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  let finishDelete;
  let pendingDelete;
  let deleteCalls = 0;
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list() { return {exists: true, entries: [{path, name: `${ids[0]}.json`, kind: "file", size: storedFile.bytes.length}], issues: []}; },
    async read() { return storedFile; },
    async create() { return null; }, write() { return false; },
    async save() { return true; }, async saveAll() { return true; },
    delete(target) {
      deleteCalls++;
      if (snapshot.blocked) return Promise.resolve(false);
      assert.equal(target, path);
      pendingDelete = new Promise(resolve => { finishDelete = () => {
        snapshot = {...snapshot, files: []};
        notify();
        resolve(true);
      }; });
      return pendingDelete;
    },
    async createDirectory() { return false; },
    clearError() {},
    async beginLeave() {
      snapshot = {...snapshot, blocked: true};
      notify();
      await pendingDelete;
      return true;
    },
  };
  const adapter = createTimelineListFiles(storage);
  await adapter.load();

  let leaveStarted = false;
  let leaving;
  adapter.subscribe(() => {
    if (adapter.getSnapshot().deletingId && !leaveStarted) {
      leaveStarted = true;
      assert.equal(deleteCalls, 1, "storage accepted deletion before notifying the UI");
      leaving = storage.beginLeave();
    }
  });

  const deleting = adapter.delete(ids[0]);
  assert.equal(leaveStarted, true);
  assert.equal(adapter.getSnapshot().blocked, true);
  let leaveSettled = false;
  void leaving.then(() => { leaveSettled = true; });
  await Promise.resolve();
  assert.equal(leaveSettled, false, "project leave waits for the accepted delete");

  finishDelete();
  assert.equal(await deleting, true);
  assert.equal(await leaving, true);
  assert.equal(deleteCalls, 1);
  adapter.dispose();
});

test("a directory read is installed and accepted before loading subscribers can start leave", async () => {
  let snapshot = {files: [], blocked: false, error: null};
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  let releaseList;
  let pendingList;
  let listCalls = 0;
  const storage = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    list() {
      listCalls++;
      if (snapshot.blocked) return Promise.resolve(null);
      pendingList = new Promise(resolve => { releaseList = resolve; });
      notify(); // Storage has accepted the directory read and publishes its own snapshot.
      return pendingList;
    },
    async read() { return null; }, async create() { return null; }, write() { return false; },
    async save() { return false; }, async saveAll() { return false; }, async delete() { return false; },
    async createDirectory() { return false; }, clearError() {},
    async beginLeave() {
      snapshot = {...snapshot, blocked: true};
      notify();
      await pendingList;
      return true;
    },
  };
  const adapter = createTimelineListFiles(storage);
  let subscriberCalled = false;
  let reentrantLoad;
  let leaving;
  adapter.subscribe(() => {
    if (adapter.getSnapshot().loading && !subscriberCalled) {
      subscriberCalled = true;
      reentrantLoad = adapter.load();
      leaving = storage.beginLeave();
    }
  });

  const loading = adapter.load();
  assert.strictEqual(reentrantLoad, loading, "loadOperation exists before reentrant subscribers run");
  assert.equal(listCalls, 1);
  assert.equal(adapter.getSnapshot().blocked, true);
  let leaveSettled = false;
  void leaving.then(() => { leaveSettled = true; });
  await Promise.resolve();
  assert.equal(leaveSettled, false, "leave waits for the already accepted directory read");

  releaseList({exists: false, entries: [], issues: []});
  assert.equal(await loading, true);
  assert.equal(await leaving, true);
  assert.equal(adapter.getSnapshot().loaded, true);
  adapter.dispose();
});

test("load keeps valid records visible, reports malformed files, and sorts by creation time then ID", async () => {
  const api = timelineFiles({files: [
    timelineFile(ids[1], file(ids[1], {createdAt: "2026-10-23T08:00:00.100Z", title: "后创建"})),
    timelineFile(ids[0], file(ids[0], {createdAt: "2026-10-23T08:00:00Z", title: "先创建"})),
    timelineFile(ids[2], {...file(ids[2]), eventCount: 9}),
  ], issues: [{name: "missing.json", message: "读取失败"}]});
  api.load = async () => { api.calls.loads++; api.emit({loaded: true}); return true; };
  const model = modelFor(api);
  await model.load();

  const snapshot = model.getSnapshot();
  assert.deepEqual(Array.from(snapshot.entries, entry => entry.title), ["先创建", "后创建"]);
  assert.equal(snapshot.entries[0].period, "");
  assert.equal(snapshot.entries[0].eventCount, 0);
  assert.equal(snapshot.issues.length, 2, "file read errors and malformed JSON records are both surfaced");
  assert.equal(snapshot.error, null);
  assert.ok(snapshot.issues.some(issue => issue.message.includes("字段")));
  model.dispose();
});

test("a failed initial load can be retried without treating the collection as an empty list", async () => {
  const api = timelineFiles();
  let fail = true;
  api.load = async () => {
    api.calls.loads++;
    api.emit({loading: true});
    if (fail) {
      api.emit({loading: false, loaded: false, error: "时间线目录不可读"});
      return false;
    }
    api.emit({loading: false, loaded: true, error: null, files: [timelineFile(ids[0], file(ids[0]))]});
    return true;
  };
  const model = modelFor(api);
  assert.equal(await model.load(), false);
  assert.equal(model.getSnapshot().entries.length, 0);
  assert.equal(model.getSnapshot().loaded, false);
  assert.equal(model.getSnapshot().error, "时间线目录不可读");
  assert.equal(model.getSnapshot().busy, true, "the unloaded collection remains closed to mutations");
  assert.equal(model.getSnapshot().retryDisabled, false, "retry remains available for an unloaded collection");

  fail = false;
  assert.equal(await model.retry(), true);
  assert.equal(api.calls.loads, 2);
  assert.equal(model.getSnapshot().loaded, true);
  assert.equal(model.getSnapshot().error, null);
  assert.equal(model.getSnapshot().entries.length, 1);
  model.dispose();
});

test("a failed create retains its draft ID and timestamp, and success stores only list fields", async () => {
  const api = timelineFiles({loaded: true});
  let fail = true;
  api.create = async (id, content) => {
    api.calls.created.push({id, content});
    if (fail) {
      api.emit({error: "磁盘只读"});
      return null;
    }
    const saved = {id, content, saveState: "saved", saveError: null};
    api.emit({files: [...api.getSnapshot().files, saved], error: null});
    return saved;
  };
  let generated = 0;
  const model = modelFor(api, {createId: () => { generated++; return ids[2]; }});
  model.beginCreate();
  model.updateCreateDraft({title: "  新线  ", summary: "梗概"});
  assert.equal(await model.create(), false);
  assert.equal(model.getSnapshot().createDraft.id, ids[2]);
  assert.equal(model.getSnapshot().retryLabel, "重试创建");
  assert.equal(generated, 1);

  fail = false;
  assert.equal(await model.retry(), true);
  const written = JSON.parse(api.calls.created.at(-1).content);
  assert.deepEqual(Object.keys(written), ["format", "schemaVersion", "id", "title", "summary", "createdAt", "updatedAt"]);
  assert.equal(written.title, "新线");
  assert.equal(written.summary, "梗概");
  assert.equal(written.createdAt, stamp);
  assert.equal(written.updatedAt, stamp);
  assert.equal(generated, 1);
  assert.equal(model.getSnapshot().createDraft, null);
  assert.equal(model.getSnapshot().selectedId, ids[2]);
  assert.equal(model.getSnapshot().entries[0].eventCount, 0);
  model.dispose();
});

test("failed delete preserves the selected row and retry selects its adjacent entry", async () => {
  const api = timelineFiles({loaded: true, files: [
    timelineFile(ids[0], file(ids[0], {title: "第一条"})),
    timelineFile(ids[1], file(ids[1], {title: "第二条", createdAt: "2026-10-24T08:00:00Z"})),
  ]});
  let fail = true;
  api.delete = async id => {
    api.calls.deleted.push(id);
    if (fail) { api.emit({error: "删除失败"}); return false; }
    api.emit({files: api.getSnapshot().files.filter(item => item.id !== id), error: null});
    return true;
  };
  const model = modelFor(api);
  model.select(ids[0]);
  assert.equal(await model.remove(ids[0]), false);
  assert.equal(model.getSnapshot().entries.length, 2);
  assert.equal(model.getSnapshot().selectedId, ids[0]);

  fail = false;
  assert.equal(await model.retry(), true);
  assert.deepEqual(Array.from(model.getSnapshot().entries, entry => entry.id), [ids[1]]);
  assert.equal(model.getSnapshot().selectedId, ids[1]);
  model.dispose();
});

test("a pending creation locks its form draft so edits cannot disappear when the accepted write completes", async () => {
  const api = timelineFiles({loaded: true});
  let complete;
  api.create = (id, content) => {
    api.emit({creating: true});
    return new Promise(resolve => {
      complete = () => {
        const saved = {id, content, saveState: "saved", saveError: null};
        api.emit({creating: false, files: [saved]});
        resolve(saved);
      };
    });
  };
  const model = modelFor(api);
  model.beginCreate();
  model.updateCreateDraft({title: "已提交名称", summary: "已提交梗概"});
  const creation = model.create();
  model.updateCreateDraft({title: "迟到的输入"});
  model.cancelCreate();
  assert.equal(model.getSnapshot().createDraft.title, "已提交名称");
  complete();
  assert.equal(await creation, true);
  assert.equal(model.getSnapshot().entries[0].title, "已提交名称");
  model.dispose();
});

test("disposed session models ignore late results", async () => {
  const api = timelineFiles({loaded: true});
  let complete;
  api.create = () => new Promise(resolve => { complete = resolve; });
  const model = modelFor(api);
  let updates = 0;
  model.subscribe(() => updates++);
  model.beginCreate();
  model.updateCreateDraft({title: "保留"});
  const creation = model.create();
  model.dispose();
  complete({id: ids[2], content: "{}", saveState: "saved", saveError: null});
  assert.equal(await creation, false);
  assert.equal(updates, 2, "only the draft setup published before disposal");
  assert.equal(model.getSnapshot().entries.length, 0);
});
