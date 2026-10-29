import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/document-search/documentSearchSource.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exports = {};
vm.runInNewContext(code, {exports, setTimeout, clearTimeout, Promise, Map, Set, AbortController});
const wait = () => new Promise(resolve => setTimeout(resolve, 40));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
function setup() {
  const catalogListeners = new Set(), documentListeners = new Set();
  let entries = [{path: "章节.txt", name: "章节.txt"}];
  let documents = [];
  let read = async () => "旧正文";
  const requests = [];
  const catalog = {getSnapshot: () => ({entries, loading: false, error: null}),
    subscribe(listener) { catalogListeners.add(listener); return () => catalogListeners.delete(listener); }, async refresh() {}};
  const workspace = {getSnapshot: () => ({documents}),
    subscribe(listener) { documentListeners.add(listener); return () => documentListeners.delete(listener); },
    async readSearchText(path) { return read(path); },
    async open(path) { documents = [{id: "doc", path, fileName: path, content: await read(path)}]; return true; }};
  const editor = {async getSearchText(_name, content) { return content; },
    revealSearchTarget(sessionId, target) { requests.push({sessionId, target}); return true; }};
  return {catalog, workspace, editor, requests,
    setRead(value) { read = value; },
    setDocuments(value) { documents = value; for (const listener of documentListeners) listener(); },
    setEntries(value) { entries = value; for (const listener of catalogListeners) listener(); },
    listeners: () => catalogListeners.size + documentListeners.size};
}

test("indexes document text and verifies a match before opening", async () => {
  const f = setup();
  const derived = exports.createDocumentSearchSource("session", f.catalog, f.workspace, f.editor);
  await wait();
  const snapshot = derived.source.getSnapshot();
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.records[0].text, "旧正文");
  const match = {start: 1, end: 3, text: "正文", sourceText: "旧正文", line: 1};
  assert.equal(await derived.source.open("章节.txt", match), true);
  assert.equal(f.requests[0].sessionId, "session");
  assert.equal(f.requests[0].target.range.start, 1);
  f.setRead(async () => "新正文");
  assert.equal(await derived.source.open("章节.txt", match), false, "changed content is never opened at an obsolete position");
  derived.dispose();
  assert.equal(f.listeners(), 0);
});

test("new edits replace pending reads and deleted paths cannot reappear", async () => {
  const f = setup(), gate = deferred();
  let first = true;
  f.setRead(async () => first ? (first = false, gate.promise) : "最新正文");
  const derived = exports.createDocumentSearchSource("session", f.catalog, f.workspace, f.editor);
  await wait();
  f.setDocuments([{id: "doc", path: "章节.txt", content: "最新正文"}]);
  gate.resolve("旧正文");
  await wait();
  assert.equal(derived.source.getSnapshot().records[0].text, "最新正文");
  f.setEntries([]);
  await wait();
  assert.equal(derived.source.getSnapshot().records.length, 0);
  derived.dispose();
});
