import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/project-storage/bytes.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;

function loadBytes(overrides = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Array, Object, Number, Uint8Array, WeakSet, Promise, Date,
    ...overrides,
  });
  return exports;
}

function testScheduler({onDefine = () => {}, time = () => 0} = {}) {
  let pendingInChunk = 0;
  let maxChunk = 0;
  let yields = 0;
  let closes = 0;
  const chunks = [];
  return {
    scheduler: {
      now: time,
      async yieldTask() {
        chunks.push(pendingInChunk);
        maxChunk = Math.max(maxChunk, pendingInChunk);
        pendingInChunk = 0;
        yields++;
      },
      close() { closes++; },
    },
    onDefine(key) {
      if (key === "length") return;
      pendingInChunk++;
      onDefine(key);
    },
    result() {
      if (pendingInChunk > 0) {
        chunks.push(pendingInChunk);
        maxChunk = Math.max(maxChunk, pendingInChunk);
        pendingInChunk = 0;
      }
      return {yields, maxChunk, closes, chunks};
    },
  };
}

function trackedBytes(tracker, extra = {}) {
  const trackedObject = Object.create(Object);
  trackedObject.defineProperty = (target, key, descriptor) => {
    if (Array.isArray(target)) tracker.onDefine(key);
    return Object.defineProperty(target, key, descriptor);
  };
  return loadBytes({...extra, Object: trackedObject});
}

test("small async copies keep the synchronous frozen-array behavior and Array.from iterator semantics", async () => {
  const bytes = loadBytes();
  const input = [1, 2, 3];
  input[Symbol.iterator] = function* () { yield 255; yield 0; };
  let schedulerCreated = false;
  const copy = await bytes.copyBytesAsync(input, {schedulerFactory() { schedulerCreated = true; throw new Error("unexpected scheduler"); }});
  assert.deepEqual(copy, [255, 0]);
  assert.equal(Object.isFrozen(copy), true);
  assert.equal(schedulerCreated, false);
  assert.notStrictEqual(copy, input);
});

test("large async copies yield in bounded batches and match a frozen dense ordinary Array", async () => {
  const tracker = testScheduler();
  const bytes = trackedBytes(tracker);
  const input = Array.from({length: 65_537}, (_value, index) => index % 256);
  const pending = bytes.copyBytesAsync(input, {schedulerFactory: () => tracker.scheduler});
  // The source is captured before the first asynchronous task boundary.
  input[0] = 17;
  const copy = await pending;
  const expected = Object.freeze(Array.from({length: input.length}, (_value, index) => index % 256));
  const schedule = tracker.result();

  assert.equal(Array.isArray(copy), true);
  assert.equal(copy instanceof Array, true);
  assert.strictEqual(Object.getPrototypeOf(copy), Array.prototype);
  assert.equal(Object.isFrozen(copy), true);
  assert.deepEqual(copy, expected);
  assert.deepEqual(Reflect.ownKeys(copy), Reflect.ownKeys(expected));
  assert.deepEqual(Object.keys(copy), Object.keys(expected));
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, "length"), Object.getOwnPropertyDescriptor(expected, "length"));
  for (const index of ["0", "1", "2047", "2048", "65536"]) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(copy, index), Object.getOwnPropertyDescriptor(expected, index));
  }
  assert.deepEqual([...copy.keys()].slice(0, 4), [0, 1, 2, 3]);
  assert.deepEqual([...copy].slice(0, 4), [0, 1, 2, 3]);
  assert.throws(() => { "use strict"; copy[0] = 99; }, TypeError);
  assert.throws(() => Object.defineProperty(copy, "0", {value: 99}), TypeError);
  assert.ok(schedule.yields > 0);
  assert.ok(schedule.maxChunk <= 2048);
  assert.equal(schedule.closes, 1);
});

test("large async copies yield when the 3.5ms budget expires before the item cap", async () => {
  let clockCalls = 0;
  const tracker = testScheduler({time: () => clockCalls++ === 0 ? 0 : 4});
  const bytes = trackedBytes(tracker);
  const input = new Array(65_536).fill(1);
  await bytes.copyBytesAsync(input, {schedulerFactory: () => tracker.scheduler});
  const schedule = tracker.result();

  assert.equal(schedule.chunks[0], 32);
  assert.ok(schedule.chunks[0] < 2048);
  assert.ok(schedule.yields > 0);
  assert.equal(schedule.closes, 1);
});

test("large async copies validate after yields without exposing or owning a partial result", async () => {
  const tracker = testScheduler();
  const bytes = trackedBytes(tracker);
  const input = new Array(65_537).fill(7);
  input[4_500] = 256;
  const pending = bytes.copyBytesAsync(input, {schedulerFactory: () => tracker.scheduler});
  assert.equal(input[0], 7);
  await assert.rejects(pending, /文件字节必须是 0 到 255 的整数/);
  assert.ok(tracker.result().yields >= 2);
  assert.equal(tracker.result().closes, 1);
  // Failed work never alters or freezes the caller's source array.
  assert.equal(Object.isFrozen(input), false);
  input[0] = 9;
  assert.equal(input[0], 9);
});

test("each large copy gets its own scheduler, cleanup runs on failure, and owned arrays are reused", async () => {
  const bytes = loadBytes();
  const created = [];
  const schedulerFactory = () => {
    const scheduler = testScheduler().scheduler;
    created.push(scheduler);
    return scheduler;
  };
  const left = Array(65_536).fill(1);
  const right = Array(65_536).fill(2);
  const [leftCopy, rightCopy] = await Promise.all([
    bytes.copyBytesAsync(left, {schedulerFactory}),
    bytes.copyBytesAsync(right, {schedulerFactory}),
  ]);
  assert.equal(created.length, 2);
  assert.notStrictEqual(leftCopy, rightCopy);
  assert.strictEqual(await bytes.copyBytesAsync(leftCopy, {schedulerFactory() { throw new Error("owned bytes should bypass scheduling"); }}), leftCopy);

  const invalid = Array(65_536).fill(0);
  invalid[5_000] = -1;
  const failed = testScheduler();
  await assert.rejects(bytes.copyBytesAsync(invalid, {schedulerFactory: () => failed.scheduler}), /文件字节/);
  assert.equal(failed.result().closes, 1);
});

test("MessageChannel path closes its private ports and timer fallback yields when MessageChannel is absent", async t => {
  const input = new Array(65_536).fill(3);
  if (typeof MessageChannel !== "undefined") {
    const channelBytes = loadBytes({MessageChannel});
    const result = await channelBytes.copyBytesAsync(input);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.length, input.length);
  } else {
    t.skip("MessageChannel is unavailable in this runtime");
  }

  let timerYields = 0;
  const fallbackBytes = loadBytes({
    MessageChannel: undefined,
    setTimeout(callback, delay) {
      timerYields++;
      assert.equal(delay, 0);
      return globalThis.setTimeout(callback, delay);
    },
    clearTimeout(timer) { globalThis.clearTimeout(timer); },
    performance,
  });
  const fallback = await fallbackBytes.copyBytesAsync(input);
  assert.equal(Object.isFrozen(fallback), true);
  assert.ok(timerYields > 0);
});
