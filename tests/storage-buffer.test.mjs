import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compile = source => ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const compiled = compile(await readFile(new URL("../src/plugins/project-storage/FileSession.ts", import.meta.url), "utf8"));
const byteExports = {};
vm.runInNewContext(compile(await readFile(new URL("../src/plugins/project-storage/bytes.ts", import.meta.url), "utf8")), {exports: byteExports, Array, Object, Number});
const base = [0, 128, 255];
function fixture(write, changed = () => {}) {
  const timers = new Map();
  let timerId = 0;
  const exports = {};
  vm.runInNewContext(compiled, {exports, Object,
    require(name) {
      if (name === "./storageApi") return {storageErrorMessage: cause => cause.message};
      if (name === "./bytes") return byteExports;
      throw new Error(`Unexpected import ${name}`);
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const session = new exports.FileSession({path: "assets/raw.bin", fileName: "raw.bin", bytes: base}, write, changed);
  return {session, timers, flushTimer() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); }};
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

test("only internally owned canonical frozen bytes are reused without revalidation", () => {
  const canonical = byteExports.copyBytes([0, 128, 255]);
  assert.equal(Object.isFrozen(canonical), true);
  assert.strictEqual(byteExports.copyBytes(canonical), canonical);
  const externalFrozen = Object.freeze([0, 128, 255]);
  assert.notStrictEqual(byteExports.copyBytes(externalFrozen), externalFrozen);
  for (const invalid of [[0, 256], [-1], [0.5], [NaN], [Infinity], ["1"], Array(1)]) {
    assert.throws(() => byteExports.copyBytes(Object.freeze(invalid)), /字节/);
  }
});

test("byte edits schedule autosave, save the latest bytes, and skip identical data", async () => {
  const writes = [];
  const {session, flushTimer, timers} = fixture(async (...args) => { writes.push(args); });
  session.write([1, 0]);
  session.write([2, 255, 0]);
  assert.equal(session.file.saveState, "pending");
  assert.equal(writes.length, 0);
  assert.equal(timers.size, 1);
  flushTimer();
  assert.equal(await session.save(), true);
  assert.deepEqual(writes, [["assets/raw.bin", [2, 255, 0], base]]);
  assert.equal(session.file.dirty, false);
  await session.save();
  assert.equal(writes.length, 1);
});

test("byte edits during saving are serialized against the bytes that reached disk", async () => {
  const first = deferred();
  const writes = [];
  const {session} = fixture(async (...args) => { writes.push(args); if (writes.length === 1) await first.promise; });
  session.write([1]);
  const saving = session.save();
  session.write([2, 128]);
  assert.strictEqual(session.save(), saving);
  first.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(writes, [["assets/raw.bin", [1], base], ["assets/raw.bin", [2, 128], [1]]]);
  assert.deepEqual(session.file.bytes, [2, 128]);
  assert.equal(session.file.saveState, "saved");
});

test("undoing to the original bytes during an accepted write persists the undo", async () => {
  const first = deferred();
  const writes = [];
  const {session} = fixture(async (...args) => { writes.push(args); if (writes.length === 1) await first.promise; });
  session.write([10, 255]);
  const saving = session.save();
  session.write(base);
  first.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(writes.at(-1), ["assets/raw.bin", base, [10, 255]]);
  assert.equal(session.file.dirty, false);
});

test("a failed byte save retains the draft and retries the original byte baseline", async () => {
  let fail = true;
  const writes = [];
  const {session} = fixture(async (...args) => { writes.push(args); if (fail) throw new Error("不可写"); });
  session.write([255, 0]);
  assert.equal(await session.save(), false);
  assert.deepEqual(session.file.bytes, [255, 0]);
  assert.equal(session.file.saveState, "error");
  fail = false;
  assert.equal(await session.save(), true);
  assert.deepEqual(writes.at(-1), ["assets/raw.bin", [255, 0], base]);
  assert.equal(session.file.saveError, null);
});

test("disposing a byte buffer flushes scheduled edits and removes its timer", async () => {
  const writes = [];
  const {session, timers} = fixture(async (...args) => { writes.push(args); });
  session.write([0, 255, 1]);
  assert.equal(await session.dispose(), true);
  assert.equal(timers.size, 0);
  assert.deepEqual(writes, [["assets/raw.bin", [0, 255, 1], base]]);
});

test("throwing byte-buffer listeners cannot strand save or dispose", async () => {
  const writes = [];
  const f = fixture(async (...args) => { writes.push(args); }, () => { throw new Error("subscriber failed"); });
  f.session.write([1, 255]);
  assert.equal(await f.session.save(), true);
  f.session.write([2, 0]);
  assert.equal(await f.session.dispose(), true);
  assert.equal(writes.length, 2);
  assert.equal(f.timers.size, 0);
});
