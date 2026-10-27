import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compile = source => ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const byteViewSource = compile(await readFile(new URL("../src/plugins/project-storage/byteView.ts", import.meta.url), "utf8"));
const byteCopySource = compile(await readFile(new URL("../src/plugins/project-storage/bytes.ts", import.meta.url), "utf8"));
const fileSessionSource = compile(await readFile(new URL("../src/plugins/project-storage/FileSession.ts", import.meta.url), "utf8"));
const projectFilesSource = compile(await readFile(new URL("../src/plugins/project-storage/createProjectFiles.ts", import.meta.url), "utf8"));

function execute(source, modules = {}) {
  const exports = {};
  vm.runInNewContext(source, {
    exports, Object, Array, Number, WeakMap, ArrayBuffer, Uint8Array, Promise, Date, setTimeout, clearTimeout,
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return exports;
}

function createModules(storageApi = {}) {
  const byteView = execute(byteViewSource);
  const bytes = execute(byteCopySource, {"./byteView": byteView});
  const fileSession = execute(fileSessionSource, {
    "./storageApi": {storageErrorMessage: error => error.message, ...storageApi},
    "./bytes": bytes,
    "./byteView": byteView,
  });
  const projectFiles = execute(projectFilesSource, {
    "./FileSession": fileSession,
    "./storageApi": {storageErrorMessage: error => error.message, ...storageApi},
    "./bytes": bytes,
    "./byteView": byteView,
  });
  return {byteView, bytes, fileSession, projectFiles};
}

test("byte-view capsules isolate input and output memory and expose only a frozen copy API", () => {
  const {byteView} = createModules();
  const source = new Uint8Array([0, 128, 255, 17]);
  const view = byteView.createProjectByteView(source);
  source.fill(4);

  assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(Reflect.ownKeys(view), ["byteLength", "copyTo", "equals"]);
  assert.equal(view.byteLength, 4);
  assert.strictEqual(byteView.createProjectByteView(view), view, "an owned immutable capsule is safe to reuse");
  assert.equal(view.equals(view), true, "identity equality is constant-time");

  const target = new Uint8Array(7).fill(9);
  let targetSetCalled = false;
  let leakedSource;
  Object.defineProperty(target, "set", {value(source) { targetSetCalled = true; leakedSource = source; source.fill(33); }});
  view.copyTo(target, 2, 1, 2);
  assert.equal(targetSetCalled, false, "copyTo bypasses caller-overridden target.set");
  assert.equal(leakedSource, undefined, "the private source view is never passed to caller methods");
  assert.deepEqual([...target], [9, 9, 128, 255, 9, 9, 9]);
  view.copyTo(target, 0, 3);
  assert.deepEqual([...target], [17, 9, 128, 255, 9, 9, 9]);
  target.fill(0);
  assert.equal(view.equals([0, 128, 255, 17]), true, "mutating the destination cannot mutate the capsule");
  assert.equal(view.equals(new Uint8Array([0, 128, 255, 17])), true);
  assert.equal(view.equals(byteView.createProjectByteView([0, 128, 255, 17])), true);
  assert.equal(view.equals([0, 128, 255]), false);

  const constructorDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor");
  let speciesCalled = false;
  let exposedBuffer;
  try {
    Object.defineProperty(Uint8Array.prototype, "constructor", {
      configurable: true,
      value: {[Symbol.species](buffer) { speciesCalled = true; exposedBuffer = buffer; return new Uint8Array(4); }},
    });
    view.copyTo(new Uint8Array(4));
  } finally {
    Object.defineProperty(Uint8Array.prototype, "constructor", constructorDescriptor);
  }
  assert.equal(speciesCalled, false, "copyTo never consults a caller-modified typed-array species");
  assert.equal(exposedBuffer, undefined, "no private backing buffer reaches a species callback");
  assert.throws(() => view.copyTo(new Uint8ClampedArray(4)), /Uint8Array/);
  assert.throws(() => view.copyTo(new Uint8Array(2)), /range/);
});

test("foreign views and legacy arrays are copied into private compact storage", () => {
  const {byteView, bytes} = createModules();
  let foreignBytes = new Uint8Array([5, 6, 7]);
  let retainedTarget;
  const foreign = Object.freeze({
    get byteLength() { return foreignBytes.length; },
    copyTo(target, targetOffset = 0, sourceOffset = 0, length = foreignBytes.length - sourceOffset) {
      retainedTarget = target;
      target.set(foreignBytes.subarray(sourceOffset, sourceOffset + length), targetOffset);
    },
    equals() { return false; },
  });
  const view = byteView.createProjectByteView(foreign);
  retainedTarget.fill(99);
  foreignBytes.fill(0);
  assert.equal(view.equals([5, 6, 7]), true);

  const typedInput = new Uint8Array([8, 9]);
  Object.defineProperty(typedInput, "constructor", {get() { throw new Error("input constructor must not be read"); }});
  const typedView = byteView.createProjectByteView(typedInput);
  typedInput.fill(0);
  assert.equal(typedView.equals([8, 9]), true);

  let hostileTarget;
  const hostileForeign = Object.freeze({
    byteLength: 3,
    copyTo(target) { hostileTarget = target; target.fill(42); },
    equals() { return true; },
  });
  assert.equal(view.equals(hostileForeign), false);
  hostileTarget.fill(1);
  assert.equal(view.equals([5, 6, 7]), true, "external copyTo can only mutate its scratch target");

  const legacy = byteView.createProjectByteView([0, 255, 128]);
  const materialized = bytes.copyBytes(legacy);
  assert.deepEqual(materialized, [0, 255, 128]);
  assert.equal(Object.isFrozen(materialized), true);
  assert.equal(Array.isArray(materialized), true);
  assert.notStrictEqual(materialized, legacy);
  assert.throws(() => byteView.createProjectByteView([0, 256]), /0 到 255/);
});

test("ProjectFiles.captureBytes isolates input without publishing a file and rejects calls after disposal", async () => {
  const calls = [];
  const {projectFiles, byteView} = createModules({
    async saveFile(...args) { calls.push(["save", ...args]); },
    async deleteFile(...args) { calls.push(["delete", ...args]); },
  });
  const controller = projectFiles.createProjectFiles("/book");
  const files = controller.service;
  let notifications = 0;
  files.subscribe(() => { notifications++; });
  const input = new Uint8Array([0, 128, 255]);
  const captured = files.captureBytes(input);
  input.fill(9);

  assert.equal(byteView.isOwnedProjectByteView(captured), true);
  assert.equal(captured.equals([0, 128, 255]), true, "captured bytes are isolated from later caller mutation");
  assert.equal(files.getSnapshot().files.length, 0, "capturing bytes does not register a project file");
  assert.equal(notifications, 0, "capturing bytes does not publish a storage snapshot");
  assert.deepEqual(calls, [], "capturing bytes does not perform persistence work");

  await controller.dispose();
  assert.throws(() => files.captureBytes(new Uint8Array([1])), /已关闭/);
});

test("opt-in views preserve custom Array.from iteration semantics", () => {
  const {byteView} = createModules();
  const array = [1, 2, 3];
  array[Symbol.iterator] = function* () { yield 255; yield 0; };
  assert.equal(byteView.createProjectByteView(array).equals([255, 0]), true);

  const typed = new Uint8Array([1, 2, 3]);
  typed[Symbol.iterator] = function* () { yield 9; yield 10; };
  assert.equal(byteView.createProjectByteView(typed).equals([9, 10]), true);

  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator);
  try {
    Object.defineProperty(typedArrayPrototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function* () { yield 11; yield 12; },
    });
    assert.equal(byteView.createProjectByteView(new Uint8Array([1, 2, 3])).equals([11, 12]), true);
  } finally {
    Object.defineProperty(typedArrayPrototype, Symbol.iterator, iteratorDescriptor);
  }

  const detached = new Uint8Array([1]);
  structuredClone(detached.buffer, {transfer: [detached.buffer]});
  assert.throws(() => byteView.createProjectByteView(detached));
});

test("FileSession keeps one compact current buffer and baseline while legacy bytes stay lazy", async () => {
  const {byteView, fileSession} = createModules();
  const initial = byteView.createProjectByteView(new Uint8Array([0, 128, 255]));
  const persisted = [];
  let shouldFail = true;
  const session = new fileSession.FileSession(
    {path: "book.txt", fileName: "book.txt", bytes: initial},
    async (...args) => { persisted.push(args); if (shouldFail) throw new Error("conflict"); },
    () => {},
    true,
  );
  const originalFile = session.file;
  assert.strictEqual(originalFile.byteView, initial);
  assert.equal(typeof Object.getOwnPropertyDescriptor(originalFile, "bytes").get, "function");
  assert.strictEqual(session.persistedData, initial);
  assert.strictEqual(session.file, originalFile, "metadata reads do not materialize a legacy bytes array");

  session.write(new Uint8Array([1, 2, 3]));
  const edited = session.file.byteView;
  assert.deepEqual(originalFile.bytes, [0, 128, 255], "a historical snapshot remains bound to its original capsule");
  assert.strictEqual(originalFile.byteView, initial);
  assert.notStrictEqual(edited, initial);
  assert.equal(session.file.dirty, true);
  const editedProjection = session.file.bytes;
  const failedSave = session.save();
  assert.strictEqual(session.file.bytes, editedProjection, "metadata-only snapshots retain the same legacy array identity");
  assert.equal(await failedSave, false);
  assert.strictEqual(session.file.byteView, edited, "a failed save retains the current capsule");
  assert.strictEqual(session.persistedData, initial, "a failed save retains the saved baseline");
  assert.equal(session.file.saveError, "conflict");
  assert.strictEqual(persisted[0][1], edited);
  assert.strictEqual(persisted[0][2], initial);

  shouldFail = false;
  assert.equal(await session.save(), true);
  assert.strictEqual(session.persistedData, edited);
  assert.equal(session.file.dirty, false);
  const legacyBytes = session.file.bytes;
  assert.deepEqual(legacyBytes, [1, 2, 3]);
  assert.equal(Object.isFrozen(legacyBytes), true);
  assert.strictEqual(session.file.bytes, legacyBytes, "legacy bytes are materialized at most once per snapshot");
  assert.strictEqual(session.persistedBytes, session.persistedBytes, "the saved compatibility projection is cached");

  const cleanLegacySession = new fileSession.FileSession(
    {path: "clean.txt", fileName: "clean.txt", bytes: [4, 5, 6]},
    async () => {},
    () => {},
  );
  cleanLegacySession.useByteView();
  assert.strictEqual(cleanLegacySession.file.byteView, cleanLegacySession.persistedData, "a clean promotion shares current and baseline capsules");
});

test("a reentrant write during first byte-view promotion keeps the newest edit and autosaves it", async () => {
  const {fileSession, byteView} = createModules();
  const persisted = [];
  let session;
  let reenter = true;
  session = new fileSession.FileSession(
    {path: "book.txt", fileName: "book.txt", bytes: [0, 0]},
    async (...args) => { persisted.push(args); },
    () => {
      if (!reenter) return;
      reenter = false;
      session.write([9, 8], {preferByteView: true});
    },
  );

  session.write([1, 2], {preferByteView: true});
  assert.equal(byteView.isOwnedProjectByteView(session.file.byteView), true);
  assert.equal(session.file.byteView.equals([9, 8]), true);
  assert.equal(session.file.dirty, true);
  assert.equal(await session.save(), true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][1].equals([9, 8]), true);
  assert.equal(session.file.dirty, false);
});

test("accepted nested input writes win while rejected nested inputs do not discard a valid capture", async () => {
  const {fileSession} = createModules();
  const session = new fileSession.FileSession({path: "book.txt", fileName: "book.txt", bytes: [0]}, async () => {}, () => {});
  const external = {
    byteLength: 1,
    copyTo(target) {
      session.write([2], {preferByteView: true});
      target[0] = 1;
    },
    equals() { return false; },
  };
  session.write(external, {preferByteView: true});
  assert.equal(session.file.byteView.equals([2]), true, "capturing an older request cannot replace a newer accepted edit");
  const withRejectedNestedInput = {
    ...external,
    copyTo(target) {
      assert.throws(() => session.write([999], {preferByteView: true}), /字节/);
      target[0] = 3;
    },
  };
  session.write(withRejectedNestedInput, {preferByteView: true});
  assert.equal(session.file.byteView.equals([3]), true, "an invalid nested request leaves the valid outer request available");
  assert.equal(await session.dispose(), true);
});

test("editing from a save-error notification keeps the new draft pending and autosaves it", async () => {
  const {fileSession} = createModules();
  let attempts = 0, reentered = false, saved;
  let session;
  session = new fileSession.FileSession({path: "book.txt", fileName: "book.txt", bytes: [0]}, async (_path, data) => {
    attempts++;
    if (attempts === 1) throw new Error("temporary failure");
    saved = data;
  }, () => {
    if (session.file.saveState === "error" && !reentered) {
      reentered = true;
      session.write([2], {preferByteView: true});
    }
  });
  session.write([1], {preferByteView: true});
  assert.equal(await session.save(), false);
  assert.equal(session.file.saveState, "pending");
  assert.equal(session.file.byteView.equals([2]), true);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(attempts, 2);
  assert.equal(saved.equals([2]), true);
  assert.equal(session.file.saveState, "saved");
  assert.equal(await session.dispose(), true);
});

test("a foreign-view getter cannot overwrite an edit accepted during its detection", async () => {
  const {fileSession} = createModules();
  let reentered = false;
  const session = new fileSession.FileSession({path: "book.txt", fileName: "book.txt", bytes: [0]}, async () => {}, () => {});
  const external = {
    get byteLength() {
      if (!reentered) {
        reentered = true;
        session.write([2], {preferByteView: true});
      }
      return 1;
    },
    copyTo(target) { target[0] = 1; },
    equals() { return false; },
  };
  session.write(external);
  assert.equal(session.file.byteView.equals([2]), true);
  assert.equal(await session.dispose(), true);
});

test("promoting a legacy session during an accepted save keeps its saved baseline compact", async () => {
  const {fileSession, byteView} = createModules();
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const session = new fileSession.FileSession(
    {path: "book.txt", fileName: "book.txt", bytes: [0, 1]},
    async () => { entered(); await gate; },
    () => {},
  );
  session.write([2, 3]);
  const saving = session.save();
  await enteredPromise;
  session.useByteView();
  const current = session.file.byteView;
  release();

  assert.equal(await saving, true);
  assert.strictEqual(session.persistedData, current);
  assert.equal(byteView.isOwnedProjectByteView(session.persistedData), true);
  assert.equal(session.file.dirty, false);
});

test("ProjectFiles keeps legacy arrays by default and routes opt-in reads, writes, and creates as views", async () => {
  const disk = new Map([["legacy.txt", [1, 2]], ["view.txt", [3, 4, 5]]]);
  const calls = [];
  const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  const api = {
    async readFile(_root, path, options) {
      calls.push(["read", path, options]);
      const bytes = disk.get(path);
      return {path, fileName: path, bytes: options?.preferByteView ? new Uint8Array(bytes) : [...bytes]};
    },
    async createFile(_root, path, bytes, options) {
      calls.push(["create", path, bytes, options]);
      const copy = new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes.byteLength ? bytes.byteLength : bytes.length);
      if (bytes instanceof Uint8Array) copy.set(bytes);
      else if (Array.isArray(bytes)) copy.set(bytes);
      else bytes.copyTo(copy);
      disk.set(path, [...copy]);
      return {path, fileName: path, bytes: options.preferByteView ? copy : [...copy]};
    },
    async saveFile(_root, path, bytes, expected) {
      calls.push(["save", path, bytes, expected]);
      const actual = disk.get(path);
      const expectedCopy = expected instanceof Uint8Array ? [...expected] : Array.isArray(expected) ? expected : (() => { const copy = new Uint8Array(expected.byteLength); expected.copyTo(copy); return [...copy]; })();
      if (!same(actual, expectedCopy)) throw new Error("disk conflict");
      const copy = new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes.byteLength ? bytes.byteLength : bytes.length);
      if (bytes instanceof Uint8Array) copy.set(bytes);
      else if (Array.isArray(bytes)) copy.set(bytes);
      else bytes.copyTo(copy);
      disk.set(path, [...copy]);
    },
    async deleteFile(_root, path, expected) {
      calls.push(["delete", path, expected]);
      if (disk.has(path)) disk.delete(path);
    },
    async listDirectory() { return {exists: true, entries: [], issues: []}; },
    async createDirectory() {},
  };
  const {projectFiles, byteView} = createModules(api);
  const controller = projectFiles.createProjectFiles("/book");
  const files = controller.service;
  try {
    const legacy = await files.read("legacy.txt");
    assert.equal(Array.isArray(legacy.bytes), true);
    assert.equal(legacy.byteView, undefined);
    assert.deepEqual(calls[0].slice(0, 2), ["read", "legacy.txt"]);
    assert.equal(calls[0][2].preferByteView, false);
    assert.equal(files.write("legacy.txt", [1, 2], {preferByteView: true}), true);
    const promoted = files.getSnapshot().files[0];
    assert.equal(byteView.isOwnedProjectByteView(promoted.byteView), true);
    assert.equal(promoted.dirty, false, "representation promotion alone does not mark identical bytes dirty");
    assert.equal(calls.some(call => call[0] === "save"), false);

    const opened = await files.read("view.txt", {preferByteView: true});
    assert.equal(byteView.isOwnedProjectByteView(opened.byteView), true);
    assert.equal(typeof Object.getOwnPropertyDescriptor(opened, "bytes").get, "function");
    assert.strictEqual(files.getSnapshot().files[1], opened, "snapshot publication does not force bytes materialization");
    assert.deepEqual(calls[1].slice(0, 2), ["read", "view.txt"]);
    assert.equal(calls[1][2].preferByteView, true);

    const nextInput = new Uint8Array([8, 9]);
    const captured = files.captureBytes(nextInput);
    nextInput.fill(0);
    assert.equal(files.write("view.txt", captured), true);
    const editedView = files.getSnapshot().files[1].byteView;
    assert.strictEqual(editedView, captured, "the built-in store installs the same captured view for a changed write");
    assert.equal(await files.save("view.txt"), true);
    const saveCall = calls.find(call => call[0] === "save");
    assert.strictEqual(saveCall[2], editedView);
    assert.strictEqual(saveCall[3], opened.byteView);
    assert.deepEqual(disk.get("view.txt"), [8, 9]);

    const created = await files.create("created.txt", new Uint8Array([10, 11]), {preferByteView: true});
    assert.equal(byteView.isOwnedProjectByteView(created.byteView), true);
    assert.equal(calls.at(-1)[0], "create");
    assert.equal(calls.at(-1)[3].preferByteView, true);
    assert.deepEqual(disk.get("created.txt"), [10, 11]);
  } finally {
    await controller.dispose();
  }
});

test("a concurrent opt-in read promotes an opening legacy file after its shared read completes", async () => {
  let enterRead;
  let releaseRead;
  const entered = new Promise(resolve => { enterRead = resolve; });
  const gate = new Promise(resolve => { releaseRead = resolve; });
  let reads = 0;
  const {projectFiles, byteView} = createModules({
    async readFile(_root, path) {
      reads++;
      enterRead();
      await gate;
      return {path, fileName: path, bytes: [4, 5, 6]};
    },
    async saveFile() {},
    async deleteFile() {},
    async listDirectory() { return {exists: true, entries: [], issues: []}; },
    async createDirectory() {},
  });
  const controller = projectFiles.createProjectFiles("/book");
  try {
    const legacyOpening = controller.service.read("opening.txt");
    await entered;
    const compactOpening = controller.service.read("opening.txt", {preferByteView: true});
    releaseRead();
    const [legacyResult, compactResult] = await Promise.all([legacyOpening, compactOpening]);
    assert.equal(reads, 1);
    assert.notStrictEqual(legacyResult, compactResult, "the pre-promotion immutable result remains a legacy snapshot");
    assert.equal(Array.isArray(legacyResult.bytes), true);
    assert.equal(byteView.isOwnedProjectByteView(compactResult.byteView), true);
  } finally {
    releaseRead();
    await controller.dispose();
  }
});
