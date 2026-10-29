import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/project-search/searchIndex.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exports = {};
vm.runInNewContext(code, {exports, setTimeout, clearTimeout, Object, Map, Set, Promise, Error, console});
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function makeSource(initial) {
  let snapshot = {records: initial, loading: false, error: null};
  const listeners = new Set();
  return {
    source: {title: "测试来源", getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      open: async id => id === "one", refresh: async () => { snapshot = {...snapshot, error: null}; for (const listener of listeners) listener(); }},
    set(patch) { snapshot = {...snapshot, ...patch}; for (const listener of listeners) listener(); },
    listenerCount: () => listeners.size,
  };
}
const record = (id, title, text = "") => ({id, kind: "资产", title, detail: "说明", text});

test("index isolates sessions, finds normalized text, reports loading and opens results", async () => {
  const index = exports.createSearchIndex();
  const first = makeSource([record("one", "主角", "称号\n青霜剑")]);
  const second = makeSource([record("two", "他人")]);
  const stop = index.registerSource("a", "assets", first.source);
  index.registerSource("b", "assets", second.source);
  assert.equal(index.getSnapshot("a").indexing, true);
  await settle();
  assert.equal(index.getSnapshot("a").indexing, false);
  assert.equal(index.search("a", "青霜")[0].detail, "说明 · 青霜剑");
  assert.equal(index.search("b", "青霜").length, 0);
  assert.equal(index.search("a", "主角", "文件").length, 0);
  assert.equal(await index.open("a", "assets", "one"), true);
  assert.equal(await index.open("a", "assets", "missing"), false);
  first.set({error: "读取失败"});
  await settle();
  assert.match(index.getSnapshot("a").issues[0], /读取失败/);
  await index.refresh("a");
  await settle();
  assert.equal(index.getSnapshot("a").issues.length, 0);
  stop();
  assert.equal(first.listenerCount(), 0);
  assert.equal(index.search("a", "主角").length, 0);
  index.dispose();
  assert.equal(second.listenerCount(), 0);
});

test("new source updates supersede unfinished batches and unregister cancels them", async () => {
  const index = exports.createSearchIndex();
  const first = makeSource(Array.from({length: 1200}, (_, i) => record(`old${i}`, "旧内容")));
  const stop = index.registerSource("session", "source", first.source);
  first.set({records: [record("one", "新内容")]});
  await settle();
  assert.equal(index.search("session", "旧内容").length, 0);
  assert.equal(index.search("session", "新内容").length, 1);
  first.set({records: Array.from({length: 1200}, (_, i) => record(`next${i}`, "还未完成"))});
  stop();
  await settle();
  assert.equal(index.search("session", "还未完成").length, 0);
  index.dispose();
});

test("a malformed source is reported without disturbing other sources or prior records", async () => {
  const index = exports.createSearchIndex();
  const first = makeSource([record("one", "可用记录")]);
  const second = makeSource([record("two", "另一个来源")]);
  index.registerSource("a", "first", first.source);
  index.registerSource("a", "second", second.source);
  assert.throws(() => index.registerSource("a", "first", first.source), /Duplicate/);
  await settle();
  first.set({records: [record("one", "重复"), record("one", "重复")]});
  await settle();
  assert.match(index.getSnapshot("a").issues[0], /重复/);
  assert.equal(index.search("a", "可用记录").length, 1);
  assert.equal(index.search("a", "另一个来源").length, 1);
  index.dispose();
});
