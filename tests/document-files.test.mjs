import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/documents/documentFiles.ts", import.meta.url), "utf8");
const decoderSource = await readFile(new URL("../src/plugins/documents/decodeDocumentBytes.ts", import.meta.url), "utf8");
const decoderCompiled = ts.transpileModule(decoderSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const decoderMetrics = {decodes: 0, yields: 0, channelsCreated: 0, channelsClosed: 0, onYield: null};
class CountingTextDecoder extends TextDecoder {
  decode(...args) { decoderMetrics.decodes++; return super.decode(...args); }
}
class TestMessageChannel {
  closed = false;
  port1 = {onmessage: null, close: () => this.close()};
  port2 = {postMessage: () => setImmediate(() => {
    decoderMetrics.yields++;
    decoderMetrics.onYield?.();
    this.port1.onmessage?.({data: 0});
  }), close: () => this.close()};

  constructor() { decoderMetrics.channelsCreated++; }
  close() {
    if (this.closed) return;
    this.closed = true;
    decoderMetrics.channelsClosed++;
  }
}
const decoderExports = {};
vm.runInNewContext(decoderCompiled, {
  exports: decoderExports,
  TextDecoder: CountingTextDecoder,
  Uint8Array,
  MessageChannel: TestMessageChannel,
  setTimeout,
  clearTimeout,
  Promise,
});
const {decodeDocumentBytes} = decoderExports;
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
function createDocumentFilesFactory(stringConstructor) {
  const exports = {};
  const globals = {
    exports,
    TextDecoder: CountingTextDecoder,
    TextEncoder,
    Uint8Array,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
    console,
    require(specifier) {
      if (specifier === "./decodeDocumentBytes") return decoderExports;
      throw new Error(`Unexpected import '${specifier}'.`);
    },
  };
  if (stringConstructor !== undefined) globals.String = stringConstructor;
  vm.runInNewContext(compiled, globals);
  return exports.createDocumentFiles;
}
const createDocumentFiles = createDocumentFilesFactory();

function fixture(initialFiles = []) {
  let files = initialFiles;
  let blocked = false;
  let sourceError = null;
  let writeFailure = false;
  let lastWriteInput = null;
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const storage = {
    getSnapshot() { return {files, blocked, error: sourceError}; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async read(path) { return files.find(file => file.path === path) ?? null; },
    write(path, data) {
      lastWriteInput = data;
      const current = files.find(candidate => candidate.path === path);
      if (!current || writeFailure) {
        if (writeFailure) {
          sourceError = "write failed";
          notify();
        }
        return false;
      }
      const bytes = Object.freeze(Array.from(data));
      const same = current.bytes.length === bytes.length && current.bytes.every((byte, index) => byte === bytes[index]);
      if (!same) {
        files = files.map(candidate => candidate.path === path
          ? file(bytes, {path, fileName: current.fileName, dirty: true, saveState: "pending", saveError: null})
          : candidate);
        notify();
      }
      return true;
    },
    emit(nextFiles = files, options = {}) {
      files = nextFiles;
      if ("blocked" in options) blocked = options.blocked;
      if ("error" in options) sourceError = options.error;
      notify();
    },
    listenerCount() { return listeners.size; },
    setWriteFailure(value) { writeFailure = value; },
    get lastWriteInput() { return lastWriteInput; },
  };
  return storage;
}

function file(bytes, patch = {}) {
  return Object.freeze({
    path: "chapters/one.txt",
    fileName: "one.txt",
    bytes,
    dirty: false,
    saveState: "saved",
    saveError: null,
    ...patch,
  });
}

function encode(value) {
  return Object.freeze(Array.from(new TextEncoder().encode(value)));
}

function resetDecoderMetrics() {
  decoderMetrics.decodes = 0;
  decoderMetrics.yields = 0;
  decoderMetrics.channelsCreated = 0;
  decoderMetrics.channelsClosed = 0;
  decoderMetrics.onYield = null;
}

test("document text adapter reuses content decoding while refreshing file metadata", async () => {
  decoderMetrics.decodes = 0;
  const bytes = encode("\uFEFF雪😀\n正文");
  const original = file(bytes);
  const storage = fixture([original]);
  const adapter = createDocumentFiles(storage);

  const opened = await adapter.open(original.path);
  assert.equal(opened.content, "\uFEFF雪😀\n正文", "UTF-8 BOM and Unicode content are preserved");
  assert.equal(decoderMetrics.decodes, 1);

  let notifications = 0;
  adapter.subscribe(() => { notifications++; });
  const saving = file(bytes, {dirty: true, saveState: "saving"});
  storage.emit([saving], {blocked: true});
  const savingSnapshot = adapter.getSnapshot();
  assert.notEqual(savingSnapshot.files[0], opened, "metadata changes produce a fresh text-file snapshot");
  assert.equal(savingSnapshot.files[0].content, opened.content);
  assert.equal(savingSnapshot.files[0].dirty, true);
  assert.equal(savingSnapshot.files[0].saveState, "saving");
  assert.equal(savingSnapshot.blocked, true);
  assert.equal(decoderMetrics.decodes, 1, "save state and blocked changes reuse decoded content");
  assert.ok(notifications > 0, "metadata and blocked changes notify subscribers");

  const failed = file(bytes, {dirty: true, saveState: "error", saveError: "write failed"});
  storage.emit([failed], {blocked: false});
  const failedSnapshot = adapter.getSnapshot();
  assert.notEqual(failedSnapshot.files[0], savingSnapshot.files[0]);
  assert.equal(failedSnapshot.files[0].saveState, "error");
  assert.equal(failedSnapshot.files[0].saveError, "write failed");
  assert.equal(failedSnapshot.blocked, false);
  assert.equal(decoderMetrics.decodes, 1, "save errors and unblock changes reuse decoded content");

  assert.equal((await adapter.open(original.path)).saveState, "error");
  assert.equal(decoderMetrics.decodes, 1, "the open result shares the subscription refresh decode cache");

  const replacementBytes = encode("外部替换 😀");
  const replacement = file(replacementBytes, {dirty: true, saveState: "error", saveError: "磁盘不可写"});
  storage.emit([replacement], {blocked: false});
  assert.equal(adapter.getSnapshot().files[0].content, "外部替换 😀");
  assert.equal(adapter.getSnapshot().files[0].saveError, "磁盘不可写");
  assert.equal(decoderMetrics.decodes, 2, "a new byte-buffer identity is decoded and validated once");

  const invalidBytes = Object.freeze([0xff, 0xfe]);
  storage.emit([file(invalidBytes)]);
  assert.equal(adapter.getSnapshot().files.length, 0, "invalid UTF-8 is rejected");
  assert.equal(decoderMetrics.decodes, 3);
  storage.emit([file(invalidBytes, {saveState: "error", saveError: "仍无效"})]);
  assert.equal(decoderMetrics.decodes, 3, "metadata notifications reuse a cached UTF-8 failure");

  const repaired = file(encode("修复后的内容"));
  storage.emit([repaired]);
  assert.equal(adapter.getSnapshot().files[0].content, "修复后的内容");
  assert.equal(decoderMetrics.decodes, 4, "a new byte identity is strictly decoded after invalid bytes");

  adapter.dispose();
  assert.equal(storage.listenerCount(), 0);
  storage.emit([file(encode("dispose 后"))]);
  assert.equal(decoderMetrics.decodes, 4, "disposed adapters release the content cache and stop refreshing");
});

test("update passes Uint8Array, reuses only an exact well-formed text projection and keeps storage bytes isolated", async () => {
  resetDecoderMetrics();
  const original = file(encode("before"));
  const storage = fixture([original]);
  const adapter = createDocumentFiles(storage);
  await adapter.open(original.path);
  assert.equal(decoderMetrics.decodes, 1);

  const content = "\uFEFF章节😀\r\n正文";
  assert.equal(adapter.update(original.path, content), true);
  assert.ok(storage.lastWriteInput instanceof Uint8Array, "adapter passes encoded bytes without an intermediate number array");
  assert.equal(adapter.getSnapshot().files[0].content, content);
  assert.equal(decoderMetrics.decodes, 1, "the synchronous storage notification reuses the known UTF-8 string");
  const committed = storage.getSnapshot().files[0];
  storage.lastWriteInput.fill(0);
  assert.equal(committed.bytes[0], 0xef, "storage copied mutable typed-array input before publishing");
  assert.equal(adapter.getSnapshot().files[0].content, content, "mutating the caller's input view cannot alter the shared buffer or projection");

  const external = file(encode("外部替换"), {dirty: true, saveState: "pending"});
  storage.emit([external]);
  assert.equal(adapter.getSnapshot().files[0].content, "外部替换");
  assert.equal(decoderMetrics.decodes, 2, "a different external byte identity still receives strict decoding");
  adapter.dispose();
});

test("failed writes clear candidate projections and isolated surrogates retain UTF-8 decoding semantics", async () => {
  resetDecoderMetrics();
  const original = file(encode("before"));
  const storage = fixture([original]);
  const adapter = createDocumentFiles(storage);
  await adapter.open(original.path);
  assert.equal(decoderMetrics.decodes, 1);

  storage.setWriteFailure(true);
  assert.equal(adapter.update(original.path, "failed candidate"), false);
  assert.equal(adapter.getSnapshot().files[0].content, "before");
  assert.equal(adapter.getSnapshot().error, "write failed");
  assert.equal(decoderMetrics.decodes, 1, "failed writes retain the existing projection");

  storage.setWriteFailure(false);
  storage.emit([file(encode("failed candidate"), {dirty: true, saveState: "pending"})]);
  assert.equal(adapter.getSnapshot().files[0].content, "failed candidate");
  assert.equal(decoderMetrics.decodes, 2, "a later external version is decoded instead of using the failed write candidate");

  for (const [index, malformedString] of [`left\uD800right`, "trailing\uD800", "\uDC00leading"].entries()) {
    assert.equal(adapter.update(original.path, malformedString), true);
    assert.equal(adapter.getSnapshot().files[0].content, malformedString.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
    assert.equal(decoderMetrics.decodes, 3 + index, "isolated surrogates are decoded from their encoded replacement bytes");
  }
  adapter.dispose();
});

test("well-formed UTF-16 validation uses the native method when available and keeps the manual fallback", async () => {
  let nativeCalls = 0;
  const nativeImplementation = String.prototype.isWellFormed ?? function () {
    const value = String(this);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };
  const nativeFactory = createDocumentFilesFactory({prototype: {
    isWellFormed() {
      nativeCalls++;
      return nativeImplementation.call(this);
    },
  }});
  const nativeStorage = fixture([file(encode("initial"))]);
  const nativeAdapter = nativeFactory(nativeStorage);
  await nativeAdapter.open("chapters/one.txt");
  assert.equal(nativeAdapter.update("chapters/one.txt", "valid 😀 text"), true);
  assert.ok(nativeCalls > 0, "the detected native-compatible method is invoked");
  assert.equal(nativeAdapter.getSnapshot().files[0].content, "valid 😀 text");
  nativeAdapter.dispose();

  const fallbackFactory = createDocumentFilesFactory({prototype: {}});
  const fallbackStorage = fixture([file(encode("initial"))]);
  const fallbackAdapter = fallbackFactory(fallbackStorage);
  await fallbackAdapter.open("chapters/one.txt");
  assert.equal(fallbackAdapter.update("chapters/one.txt", "lone\uD800 surrogate"), true);
  assert.equal(fallbackAdapter.getSnapshot().files[0].content, "lone\uFFFD surrogate",
    "the fallback rejects the pending projection so TextEncoder replacement semantics are preserved");
  fallbackAdapter.dispose();
});

test("refresh copies canonical byte arrays by index while preserving BOM, strict UTF-8 and custom iterators", async () => {
  resetDecoderMetrics();
  const original = file(encode("seed"));
  const storage = fixture([original]);
  const adapter = createDocumentFiles(storage);
  await adapter.open(original.path);
  assert.equal(decoderMetrics.decodes, 1);

  const withBom = file(encode("\uFEFF第一行\r\n第二行"), {dirty: true, saveState: "pending"});
  storage.emit([withBom]);
  assert.equal(adapter.getSnapshot().files[0].content, "\uFEFF第一行\r\n第二行");
  assert.equal(decoderMetrics.decodes, 2, "the fast copy still uses a fatal UTF-8 decoder and preserves BOM");

  storage.emit([file(Object.freeze([0xff]))]);
  assert.equal(adapter.getSnapshot().files.length, 0, "malformed UTF-8 is still rejected");
  assert.equal(decoderMetrics.decodes, 3);

  const customIterator = [0x41];
  customIterator[Symbol.iterator] = function* () { yield 0x42; };
  storage.emit([file(Object.freeze(customIterator))]);
  assert.equal(adapter.getSnapshot().files[0].content, "B", "noncanonical inputs keep Uint8Array.from iterator semantics");
  assert.equal(decoderMetrics.decodes, 4);

  storage.emit([file(Object.freeze([0x41, 256]))]);
  assert.equal(adapter.getSnapshot().files.length, 0, "canonical byte arrays remain validated before conversion");
  assert.equal(decoderMetrics.decodes, 4, "invalid byte numbers never reach TextDecoder");
  adapter.dispose();
});

test("document text adapter unsubscribes and clears retained state when initialization fails", () => {
  let snapshotReads = 0;
  let unsubscribeCalls = 0;
  const storage = {
    getSnapshot() {
      snapshotReads++;
      if (snapshotReads > 1) throw new Error("snapshot unavailable");
      return {files: [], blocked: false, error: null};
    },
    subscribe() { return () => { unsubscribeCalls++; }; },
  };

  assert.throws(() => createDocumentFiles(storage), /snapshot unavailable/);
  assert.equal(unsubscribeCalls, 1, "the subscription is released when initial refresh fails");
});

test("large document decoding yields across UTF-8 chunk boundaries and preserves BOM and line endings", async () => {
  resetDecoderMetrics();
  const content = `\uFEFF${"a".repeat(65_532)}😀${"雪".repeat(370_000)}\r\n`;
  const bytes = encode(content);
  assert.ok(bytes.length >= 1024 * 1024);
  assert.equal(3 + 65_532, 65_535, "the emoji starts one byte before the first chunk boundary");
  const original = file(bytes);
  const storage = fixture([original]);
  const adapter = createDocumentFiles(storage);

  const [first, second] = await Promise.all([adapter.open(original.path), adapter.open(original.path)]);

  assert.equal(first.content, content);
  assert.equal(second, first, "concurrent opens share one in-flight decode and metadata snapshot");
  assert.equal(adapter.getSnapshot().files[0].content, content);
  assert.equal(decoderMetrics.decodes, Math.ceil(bytes.length / (64 * 1024)) + 1,
    "chunks and one final decoder flush are performed once for concurrent opens");
  assert.ok(decoderMetrics.yields > 0, "large decode yields to a later task between chunks");
  assert.equal(decoderMetrics.channelsCreated, 1);
  assert.equal(decoderMetrics.channelsClosed, 1, "the MessageChannel closes after decoding");
  adapter.dispose();
});

test("chunk decoding follows byte iteration even when the reported array length differs", async () => {
  resetDecoderMetrics();
  const bytes = [0x61];
  bytes[Symbol.iterator] = function* () {
    for (let index = 0; index < 64 * 1024 + 2; index++) yield 0x62;
  };
  Object.freeze(bytes);

  assert.equal(await decodeDocumentBytes(bytes), "b".repeat(64 * 1024 + 2));
  assert.equal(decoderMetrics.yields, 1, "the decoder yields between actual iterator chunks");
  assert.equal(decoderMetrics.channelsCreated, 1);
  assert.equal(decoderMetrics.channelsClosed, 1);
});

test("large UTF-8 decode rejects an incomplete final sequence and caches that byte version", async () => {
  resetDecoderMetrics();
  const invalidBytes = Object.freeze([
    ...new Array(1024 * 1024 - 2).fill(0x61),
    0xe4, 0xb8,
  ]);
  const storage = fixture([file(invalidBytes)]);
  const adapter = createDocumentFiles(storage);

  assert.equal(await adapter.open("chapters/one.txt"), null);
  assert.equal(adapter.getSnapshot().files.length, 0);
  assert.match(adapter.getSnapshot().error ?? "", /UTF-8/);
  const decodeCount = decoderMetrics.decodes;
  assert.ok(decodeCount > 1, "the strict decoder reaches its final flush after multiple chunks");
  assert.equal(decoderMetrics.channelsCreated, decoderMetrics.channelsClosed);

  storage.emit([file(invalidBytes, {saveState: "error", saveError: "invalid source"})]);
  assert.equal(await adapter.open("chapters/one.txt"), null);
  assert.equal(decoderMetrics.decodes, decodeCount, "unchanged malformed bytes are not decoded again");
  adapter.dispose();
});

test("large open discards stale bytes after replacement and a disposed adapter never installs decoded content", async () => {
  resetDecoderMetrics();
  const staleBytes = encode("旧版本".repeat(180_000));
  const storage = fixture([file(staleBytes)]);
  const adapter = createDocumentFiles(storage);
  const latest = file(encode("最新版本"), {dirty: true, saveState: "pending"});
  let replaced = false;
  decoderMetrics.onYield = () => {
    if (replaced) return;
    replaced = true;
    storage.emit([latest]);
  };

  const opened = await adapter.open("chapters/one.txt");
  decoderMetrics.onYield = null;
  assert.ok(replaced, "the source changes while the first chunked decode is yielding");
  assert.equal(opened.content, "最新版本", "the open retries the latest byte identity");
  assert.equal(opened.saveState, "pending");
  assert.equal(adapter.getSnapshot().files[0], opened);
  assert.equal(decoderMetrics.yields, 1, "a superseded source stops after its first yielded chunk");
  adapter.dispose();
  assert.equal(decoderMetrics.channelsCreated, decoderMetrics.channelsClosed);

  resetDecoderMetrics();
  const pendingStorage = fixture([file(encode("large".repeat(220_000)))]);
  const pendingAdapter = createDocumentFiles(pendingStorage);
  let disposedDuringDecode = false;
  decoderMetrics.onYield = () => {
    if (disposedDuringDecode) return;
    disposedDuringDecode = true;
    pendingAdapter.dispose();
  };

  const discarded = await pendingAdapter.open("chapters/one.txt");
  decoderMetrics.onYield = null;
  assert.equal(disposedDuringDecode, true);
  assert.equal(discarded, null, "a decode result finishing after dispose is discarded");
  assert.equal(pendingAdapter.getSnapshot().files.length, 0);
  assert.equal(pendingStorage.listenerCount(), 0);
  assert.equal(decoderMetrics.decodes, 1, "dispose stops decoding before a second chunk or final flush");
  assert.equal(decoderMetrics.channelsCreated, decoderMetrics.channelsClosed);
});

test("deleting a source during initial large decode stops work and never installs deleted content", async () => {
  resetDecoderMetrics();
  const storage = fixture([file(encode("删除期间".repeat(150_000)))]);
  const adapter = createDocumentFiles(storage);
  decoderMetrics.onYield = () => storage.emit([]);
  try {
    assert.equal(await adapter.open("chapters/one.txt"), null);
    assert.equal(adapter.getSnapshot().files.length, 0);
    assert.equal(decoderMetrics.decodes, 1);
    assert.equal(decoderMetrics.yields, 1);
    assert.equal(decoderMetrics.channelsCreated, decoderMetrics.channelsClosed);
  } finally { decoderMetrics.onYield = null; adapter.dispose(); }
});
