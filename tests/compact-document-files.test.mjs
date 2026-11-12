import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const decoderSource = await readFile(new URL("../src/plugins/documents/decodeDocumentBytes.ts", import.meta.url), "utf8");
const decoderCompiled = ts.transpileModule(decoderSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const metrics = {decodeCalls: 0, yields: 0, copyCalls: 0, equalsCalls: 0, onYield: null};
class CountingTextDecoder extends TextDecoder {
  decode(...args) { metrics.decodeCalls++; return super.decode(...args); }
}
class TestMessageChannel {
  closed = false;
  port1 = {onmessage: null, close: () => { this.closed = true; }};
  port2 = {postMessage: () => setImmediate(() => {
    metrics.yields++;
    metrics.onYield?.();
    this.port1.onmessage?.({data: 0});
  }), close: () => { this.closed = true; }};
}
const decoderExports = {};
vm.runInNewContext(decoderCompiled, {
  exports: decoderExports,
  TextDecoder: CountingTextDecoder,
  Uint8Array,
  Array,
  MessageChannel: TestMessageChannel,
  setTimeout,
  clearTimeout,
  Promise,
});

const documentSource = await readFile(new URL("../src/plugins/documents/documentFiles.ts", import.meta.url), "utf8");
const documentCompiled = ts.transpileModule(documentSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const documentExports = {};
vm.runInNewContext(documentCompiled, {
  exports: documentExports,
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
});
const {createDocumentFiles} = documentExports;

function bytesOf(text) { return new TextEncoder().encode(text); }

function copyData(data) {
  if (data instanceof Uint8Array) return data.slice();
  if (Array.isArray(data)) return Uint8Array.from(data);
  const result = new Uint8Array(data.byteLength);
  data.copyTo(result);
  return result;
}

function compactView(input) {
  const bytes = input.slice();
  return Object.freeze({
    byteLength: bytes.length,
    copyTo(target, targetOffset = 0, sourceOffset = 0, length = bytes.length - sourceOffset) {
      metrics.copyCalls++;
      target.set(bytes.subarray(sourceOffset, sourceOffset + length), targetOffset);
    },
    equals(data) {
      metrics.equalsCalls++;
      if (data instanceof Uint8Array) {
        if (data.length !== bytes.length) return false;
        for (let index = 0; index < bytes.length; index++) if (bytes[index] !== data[index]) return false;
        return true;
      }
      if (Array.isArray(data)) {
        if (data.length !== bytes.length) return false;
        for (let index = 0; index < bytes.length; index++) if (bytes[index] !== data[index]) return false;
        return true;
      }
      if (data && typeof data.copyTo === "function" && data.byteLength === bytes.length) {
        const candidate = new Uint8Array(data.byteLength);
        data.copyTo(candidate);
        for (let index = 0; index < bytes.length; index++) if (bytes[index] !== candidate[index]) return false;
        return true;
      }
      return false;
    },
  });
}

function compactFile(path, view, patch = {}) {
  const value = {
    path,
    fileName: path.split("/").at(-1),
    byteView: view,
    dirty: false,
    saveState: "saved",
    saveError: null,
    ...patch,
  };
  Object.defineProperty(value, "bytes", {
    enumerable: true,
    get() { throw new Error(`lazy bytes array was materialized for ${path}`); },
  });
  return Object.freeze(value);
}

function arrayFile(path, bytes, patch = {}) {
  return Object.freeze({
    path,
    fileName: path.split("/").at(-1),
    bytes: Object.freeze(Array.from(bytes)),
    dirty: false,
    saveState: "saved",
    saveError: null,
    ...patch,
  });
}

function storageFixture(initialFiles = []) {
  let files = initialFiles;
  const listeners = new Set();
  let writeFailure = false;
  let writeBehavior;
  const calls = {read: [], write: [], create: [], capture: [], capturedViews: []};
  const notify = () => { for (const listener of [...listeners]) listener(); };
  function commit(path, data, {rewriteView = false} = {}) {
    const reusableView = data && typeof data.copyTo === "function" && !rewriteView;
    const owned = reusableView ? undefined : copyData(data);
    const old = files.find(item => item.path === path);
    const metadata = {dirty: true, saveState: "pending", saveError: null};
    const next = calls.preferCompact.has(path)
      ? compactFile(path, reusableView ? data : compactView(owned), metadata)
      : arrayFile(path, owned ?? copyData(data), metadata);
    files = old ? files.map(item => item.path === path ? next : item) : [...files, next];
    notify();
    return next;
  }
  calls.preferCompact = new Set(initialFiles.filter(item => item.byteView).map(item => item.path));
  const storage = {
    getSnapshot() { return {files, blocked: false, error: null}; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    captureBytes(data) {
      calls.capture.push(data);
      const view = compactView(copyData(data));
      calls.capturedViews.push(view);
      return view;
    },
    async read(path, ...args) {
      calls.read.push([path, ...args]);
      return files.find(file => file.path === path) ?? null;
    },
    async create(path, data, ...args) {
      calls.create.push([path, data, ...args]);
      if (args[0]?.preferByteView) calls.preferCompact.add(path);
      return commit(path, data);
    },
    write(path, data, ...args) {
      calls.write.push([path, data, ...args]);
      if (args[0]?.preferByteView) calls.preferCompact.add(path);
      if (!files.some(file => file.path === path)) return false;
      if (writeFailure) return false;
      if (writeBehavior) return writeBehavior({path, data, options: args[0], commit, emit: nextFiles => { files = nextFiles; notify(); }});
      commit(path, data);
      return true;
    },
    emit(nextFiles) { files = nextFiles; notify(); },
    dispose() { listeners.clear(); },
    setWriteFailure(value) { writeFailure = value; },
    setWriteBehavior(value) { writeBehavior = value; },
  };
  return {storage, calls};
}

function workspace(storage) {
  const exports = {};
  vm.runInNewContext(documentCompiled, {
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
  });
  return exports.createDocumentFiles(storage);
}

function resetMetrics() {
  metrics.decodeCalls = 0;
  metrics.yields = 0;
  metrics.copyCalls = 0;
  metrics.equalsCalls = 0;
  metrics.onYield = null;
}

test("TXT reads decode compact bytes without materializing bytes arrays and retain one byte identity", async () => {
  resetMetrics();
  const content = `\uFEFF${"a".repeat(65_532)}😀${"雪".repeat(400_000)}\r\n`;
  const path = "chapters/large.txt";
  const view = compactView(bytesOf(content));
  const storage = storageFixture([compactFile(path, view)]);
  const adapter = workspace(storage.storage);

  const opened = await adapter.open(path);
  assert.equal(opened.content, content, "chunked view decoding preserves BOM, CRLF and multibyte chunk boundaries");
  assert.equal(storage.calls.read.length, 1);
  assert.equal(storage.calls.read[0][0], path);
  assert.equal(storage.calls.read[0][1].preferByteView, true, "only TXT opts into compact storage reads");
  const callsAfterOpen = metrics.copyCalls;
  assert.equal(callsAfterOpen, Math.ceil(view.byteLength / (64 * 1024)));
  assert.ok(metrics.yields > 0);
  const decodesAfterOpen = metrics.decodeCalls;

  storage.storage.emit([compactFile(path, view, {dirty: true, saveState: "saving"})]);
  assert.equal(adapter.getSnapshot().files[0].content, content);
  assert.equal(metrics.copyCalls, callsAfterOpen, "metadata changes with the same view identity reuse cached text");
  assert.equal(metrics.decodeCalls, decodesAfterOpen);
  adapter.dispose();
});

test("the document adapter only reads, writes and creates TXT paths", async () => {
  resetMetrics();
  const txtPath = "chapters/one.txt";
  const mdPath = "chapters/two.md";
  const lodePath = "chapters/three.lode";
  const storage = storageFixture([
    compactFile(txtPath, compactView(bytesOf("before"))),
    arrayFile(mdPath, bytesOf("markdown")),
    arrayFile(lodePath, bytesOf("envelope")),
  ]);
  const adapter = workspace(storage.storage);

  await adapter.open(txtPath);
  const txt = adapter.getSnapshot().files.find(file => file.path === txtPath);
  const initialDecodeCalls = metrics.decodeCalls;
  const initialCopyCalls = metrics.copyCalls;
  const nextText = "\uFEFFedited 😀\r\n";
  assert.equal(adapter.update(txtPath, nextText), true);
  assert.equal(storage.calls.write.at(-1)[0], txtPath);
  assert.equal(storage.calls.write.at(-1)[1], storage.calls.capturedViews.at(-1), "TXT writes the same immutable view held by its pending projection");
  assert.equal(storage.calls.write.at(-1).length, 3);
  assert.equal(storage.calls.write.at(-1)[2].preferByteView, true);
  assert.equal(adapter.getSnapshot().files.find(file => file.path === txtPath).content, nextText);
  assert.equal(metrics.decodeCalls, initialDecodeCalls, "a valid synchronous byteView write reuses the exact source string");
  assert.equal(metrics.copyCalls, initialCopyCalls, "projection reuse avoids copying the newly written byteView back to text");
  assert.equal(metrics.equalsCalls, 0, "matching byteView identity accepts the exact projection without scanning bytes");
  assert.equal(storage.calls.capture.length, 1);
  assert.equal(txt.content, "before");

  const capturedInput = storage.calls.capture[0];
  storage.calls.capturedViews[0].copyTo(new Uint8Array(capturedInput.length));
  capturedInput.fill(0);
  assert.equal(storage.calls.capturedViews[0].equals(bytesOf(nextText)), true,
    "the captured compact view is isolated from the temporary TextEncoder array");

  const readsBeforeUnsupported = storage.calls.read.length;
  assert.equal(await adapter.open(mdPath), null);
  assert.equal(await adapter.open(lodePath), null);
  assert.equal(storage.calls.read.length, readsBeforeUnsupported, "unsupported paths never reach storage");
  assert.equal(adapter.update(mdPath, "edited markdown"), false);
  assert.equal(adapter.update(lodePath, "edited envelope"), false);
  assert.equal(storage.calls.write.length, 1, "unsupported paths never reach storage writes");
  assert.equal(storage.calls.capture.length, 1, "only TXT updates call the optional compact capture method");

  const createdTxt = await adapter.create("chapters", "new.txt", "new TXT");
  assert.equal(createdTxt.content, "new TXT");
  assert.equal(storage.calls.create.at(-1)[0], "chapters/new.txt");
  assert.equal(storage.calls.create.at(-1).length, 3);
  assert.equal(storage.calls.create.at(-1)[2].preferByteView, true);
  const createsBeforeUnsupported = storage.calls.create.length;
  assert.equal(await adapter.create("chapters", "new.lode", "new envelope"), null);
  assert.equal(storage.calls.create.length, createsBeforeUnsupported, "unsupported paths never reach storage creation");
  adapter.dispose();
});

test("TXT projection falls back to exact bytes for retained or rewritten views and rejects stale reentrant candidates", async () => {
  resetMetrics();
  const path = "chapters/identity.txt";
  const originalView = compactView(bytesOf("before"));
  const storage = storageFixture([compactFile(path, originalView)]);
  const adapter = workspace(storage.storage);
  await adapter.open(path);
  const decodeCount = metrics.decodeCalls;

  storage.storage.setWriteBehavior(({emit}) => {
    const current = storage.storage.getSnapshot().files;
    emit(current.map(file => file.path === path
      ? compactFile(path, originalView, {dirty: true, saveState: "pending"})
      : file));
    return true;
  });
  assert.equal(adapter.update(path, "before"), true);
  assert.equal(adapter.getSnapshot().files[0].content, "before");
  assert.ok(metrics.equalsCalls > 0, "a source retaining the old view is checked byte-for-byte");
  assert.equal(metrics.decodeCalls, decodeCount, "the old view is reused only after equal bytes are confirmed");

  const beforeRewriteEquals = metrics.equalsCalls;
  storage.storage.setWriteBehavior(({path: writePath, data, commit}) => {
    commit(writePath, data, {rewriteView: true});
    return true;
  });
  const rewritten = "rewritten view with same bytes";
  assert.equal(adapter.update(path, rewritten), true);
  assert.equal(adapter.getSnapshot().files[0].content, rewritten);
  assert.ok(metrics.equalsCalls > beforeRewriteEquals, "a replacement view is verified exactly before projection reuse");
  assert.equal(metrics.decodeCalls, decodeCount);

  const beforeFailure = adapter.getSnapshot().files[0].content;
  storage.storage.setWriteFailure(true);
  assert.equal(adapter.update(path, "failed candidate"), false);
  assert.equal(adapter.getSnapshot().files[0].content, beforeFailure, "a rejected candidate does not replace the current projection");
  assert.equal(metrics.decodeCalls, decodeCount, "failure cleanup does not decode or cache candidate text");
  storage.storage.setWriteFailure(false);

  const externalText = "newer reentrant snapshot";
  storage.storage.setWriteBehavior(({path: writePath, emit}) => {
    const current = storage.storage.getSnapshot().files;
    const external = compactFile(writePath, compactView(bytesOf(externalText)), {dirty: true, saveState: "pending"});
    emit(current.map(file => file.path === writePath ? external : file));
    return true;
  });
  const beforeExternalDecode = metrics.decodeCalls;
  assert.equal(adapter.update(path, "stale write candidate"), true);
  assert.equal(adapter.getSnapshot().files[0].content, externalText, "a newer reentrant snapshot is decoded instead of receiving stale text");
  assert.equal(metrics.decodeCalls, beforeExternalDecode + 1);

  adapter.dispose();
});

test("compact byte views preserve fatal UTF-8 rejection and stop stale decode after a yield", async () => {
  resetMetrics();
  const badPath = "bad.txt";
  const bad = compactView(new Uint8Array([0xe4, 0xb8]));
  const stalePath = "stale.txt";
  const staleView = compactView(bytesOf("旧版本".repeat(120_000)));
  const storage = storageFixture([compactFile(badPath, bad), compactFile(stalePath, staleView)]);
  const adapter = workspace(storage.storage);

  assert.equal(await adapter.open(badPath), null);
  assert.match(adapter.getSnapshot().error ?? "", /UTF-8/);

  const latest = compactFile(stalePath, compactView(bytesOf("最新版本")), {dirty: true, saveState: "pending"});
  let replaced = false;
  metrics.onYield = () => {
    if (replaced) return;
    replaced = true;
    storage.storage.emit([compactFile(badPath, bad), latest]);
  };
  const opened = await adapter.open(stalePath);
  metrics.onYield = null;
  assert.ok(replaced, "the source is replaced after the first decode yield");
  assert.equal(opened.content, "最新版本", "stale view bytes are discarded and the current identity is decoded");
  assert.equal(opened.saveState, "pending");
  adapter.dispose();
});
