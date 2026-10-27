import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, deferred, flushStartup} from "./helpers/mainStartupFixture.mjs";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

function waitForWorkbenchReady(workbench) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const check = () => {
      const state = workbench.getSnapshot();
      if (state.loading?.error) { unsubscribe(); reject(new Error(state.loading.error.message)); }
      else if (state.session && !state.busy) { unsubscribe(); resolve(); }
    };
    unsubscribe = workbench.subscribe(check);
    check();
  });
}

test("project storage owns one shared byte buffer without encoding or file-format rules", async () => {
  const f = byteStorageFixture();
  f.disk.set("/book/chapter.md", [0, 255, 128]);
  const controller = f.files();
  const files = controller.service;
  await files.read("chapter.md");
  const initial = files.getSnapshot();
  assert.strictEqual(files.getSnapshot(), initial);
  assert.equal(files.write("chapter.md", [128, 0, 255, 10]), true);
  const draft = files.getSnapshot().files[0];
  assert.equal(draft.dirty, true);
  assert.strictEqual(await files.read("chapter.md"), draft, "opening a dirty file reuses its canonical buffer");
  assert.equal(f.calls.filter(call => call.command === "read_project_file").length, 1);
  assert.equal(await files.save("chapter.md"), true);
  assert.equal(files.getSnapshot().files[0].dirty, false);
  assert.deepEqual(f.disk.get("/book/chapter.md"), [128, 0, 255, 10]);
  const created = await files.create("data.json", [255, 0, 128]);
  assert.equal(created.path, "data.json");
  assert.equal(f.disk.has("/book/data.json.md"), false);
  f.disk.delete("/book/data.json");
  assert.deepEqual((await files.create("data.json", [16])).bytes, [16], "a clean cached buffer is not proof that a disk file still exists");
  assert.equal(files.write("../outside.txt", [0]), false);
  const callsBeforeInvalidPaths = f.calls.length;
  for (const path of ["/outside.bin", "../outside.bin", "a//b.bin", "a\\b.bin", "bad\u0085.bin"]) {
    assert.equal(await files.create(path, [0]), null);
  }
  assert.equal(f.calls.length, callsBeforeInvalidPaths, "invalid paths are rejected before reaching native storage");
  assert.ok(await files.create(".any-dir/raw.bin", [0, 255], {createParents: true}), "hidden paths have no special storage meaning");
  assert.equal(await files.delete("data.json"), true);
  await controller.dispose();
  const reopened = f.files();
  assert.deepEqual((await reopened.service.read("chapter.md")).bytes, [128, 0, 255, 10]);
  await reopened.dispose();
});

test("storage leave waits for accepted reads and writes while locking new mutations", async () => {
  const entered = deferred();
  const release = deferred();
  let first = true;
  const f = byteStorageFixture({async onInvoke(command) {
    if (command === "save_project_file" && first) {
      first = false; entered.resolve(); await release.promise;
    }
  }});
  f.disk.set("/book/chapter.md", [0, 255, 128]);
  const controller = f.files();
  const files = controller.service;
  await files.read("chapter.md");
  files.write("chapter.md", [1, 0, 255]);
  const saving = files.save("chapter.md");
  await entered.promise;
  files.write("chapter.md", [2, 128, 0]);
  const leaving = controller.beginLeave();
  assert.equal(files.getSnapshot().blocked, true);
  assert.equal(files.write("chapter.md", [3]), false);
  assert.equal(await files.create("late.txt", []), null);
  release.resolve();
  assert.equal(await saving, true);
  assert.equal(await leaving, true);
  assert.deepEqual(f.disk.get("/book/chapter.md"), [2, 128, 0]);
  assert.deepEqual(f.calls.filter(call => call.command === "save_project_file").map(call => [call.args.bytes, call.args.expectedBytes]), [[[1, 0, 255], [0, 255, 128]], [[2, 128, 0], [1, 0, 255]]]);
  controller.endLeave();
  assert.equal(files.getSnapshot().blocked, false);
  await controller.dispose();
});

test("conflicts preserve dirty bytes; deletion requires explicit discard of buffered edits", async () => {
  const f = byteStorageFixture();
  f.disk.set("/book/chapter.md", [0, 255, 128]);
  const controller = f.files();
  const files = controller.service;
  await files.read("chapter.md");
  files.write("chapter.md", [13, 0]);
  assert.equal(await files.delete("chapter.md"), false);
  assert.deepEqual(f.disk.get("/book/chapter.md"), [0, 255, 128]);
  f.disk.set("/book/chapter.md", [255]);
  assert.equal(await files.save("chapter.md"), false);
  assert.deepEqual(files.getSnapshot().files[0].bytes, [13, 0]);
  assert.equal(files.getSnapshot().files[0].saveState, "error");
  assert.equal(await controller.beginLeave(), false);
  controller.endLeave();
  assert.equal(await files.delete("chapter.md", {discardChanges: true}), false);
  assert.equal(files.getSnapshot().files.length, 1);
  f.disk.set("/book/chapter.md", [0, 255, 128]);
  assert.equal(await files.delete("chapter.md", {discardChanges: true}), true);
  assert.ok(await files.create("data/raw.bin", [255, 128, 0], {createParents: true}));
  assert.equal(await files.saveAll(), true);
  await controller.dispose();
});

test("directory listings distinguish missing directories and preserve arbitrary names and per-entry issues", async () => {
  let fail = true;
  const f = byteStorageFixture({onInvoke(command) { if (fail && command === "list_project_directory") throw new Error("目录不可读取"); }});
  const controller = f.files();
  assert.equal(await controller.service.list("missing"), null);
  assert.match(controller.service.getSnapshot().error, /目录不可读取/);
  fail = false;
  const missing = await controller.service.list("missing");
  assert.equal(missing.exists, false);
  assert.equal(missing.entries.length, 0);
  await controller.service.create(".other/bytes.dat", [0, 255], {createParents: true});
  f.issues.set("/book/.other", [{path: ".other/unreadable", message: "元数据不可读"}]);
  const listing = await controller.service.list(".other");
  assert.equal(listing.exists, true);
  assert.equal(listing.entries[0].name, "bytes.dat");
  assert.equal(listing.issues[0].path, ".other/unreadable");
  assert.equal(Object.isFrozen(listing.entries[0]), true);
  await controller.dispose();
});

test("the workbench waits for an accepted document creation before releasing project storage", async () => {
  const release = deferred();
  const {f, disk} = byteStorageFixture({async onInvoke(command) { if (command === "create_project_file") await release.promise; }});
  f.start(); await flushStartup();
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const documents = f.getService(f.requireSdk("@lodestory/sdk/documents").documentsKey);
  const storage = f.getService(f.requireSdk("@lodestory/sdk/project-storage").projectStorageKey);
  const project = {id: "book", name: "故事", path: "/book"};
  assert.equal(await workbench.openProject(project), true);
  await waitForWorkbenchReady(workbench);
  const session = workbench.getSnapshot().session;
  const workspace = documents.getWorkspace(session.id);
  const fileStore = storage.getFiles(session.id);
  const creating = workspace.create("", "未完成写入");
  const closing = workbench.closeProject();
  assert.equal(fileStore.getSnapshot().blocked, true);
  assert.equal(await workspace.create("", "迟到创建"), null);
  release.resolve();
  assert.equal((await creating).path, "未完成写入.md");
  assert.equal(await closing, true);
  assert.deepEqual(disk.get("/book/未完成写入.md"), []);
  assert.equal(storage.getFiles(session.id), null);
  assert.equal(fileStore.write("未完成写入.md", [88]), false);
  assert.equal(await workbench.openProject(project), true);
  await waitForWorkbenchReady(workbench);
  assert.equal(await documents.getWorkspace(workbench.getSnapshot().session.id).open("未完成写入.md"), true);
  await f.createdCores.at(-1).unmountAll();
});

test("project storage permits initialization reads while blocking edits until the workbench is ready", async () => {
  const entered = deferred(), release = deferred();
  const {f} = byteStorageFixture({async onInvoke(command) {
    if (command === "list_documents") { entered.resolve(); await release.promise; }
  }});
  f.start(); await flushStartup();
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const storage = f.getService(f.requireSdk("@lodestory/sdk/project-storage").projectStorageKey);
  assert.equal(await workbench.openProject({id: "book", name: "故事", path: "/book"}), true);
  await entered.promise;
  const snapshot = workbench.getSnapshot();
  assert.equal(snapshot.busy, true);
  const files = storage.getFiles(snapshot.session.id);
  assert.ok(await files.list(".lodestory/assets"), "startup participants can read project data");
  assert.equal(await files.create("late.txt", []), null, "editing stays locked during startup");
  release.resolve();
  await waitForWorkbenchReady(workbench);
  await f.createdCores.at(-1).unmountAll();
});

test("failed storage disposal retains a readonly recovery snapshot and invalidates old handles", async () => {
  const f = byteStorageFixture({onInvoke(command) { if (command === "save_project_file") throw new Error("磁盘不可写"); }});
  f.disk.set("/book/chapter.md", [0, 255, 128]);
  const controller = f.files();
  const files = controller.service;
  await files.read("chapter.md");
  files.write("chapter.md", [0, 128, 255, 0]);
  await assert.rejects(controller.dispose(), error => {
    assert.deepEqual(error.snapshot.files[0].bytes, [0, 128, 255, 0]);
    assert.equal(Object.isFrozen(error.snapshot.files), true);
    return true;
  });
  assert.deepEqual(files.getSnapshot().files[0].bytes, [0, 128, 255, 0]);
  assert.equal(files.write("chapter.md", [99]), false);
  assert.equal(await files.read("chapter.md"), null);
});

test("byte snapshots and accepted writes are isolated from mutable caller-owned arrays", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const files = controller.service;
  const input = new Uint8Array([0, 255, 128]);
  const creating = files.create("raw.bin", input);
  input.fill(4);
  const created = await creating;
  assert.deepEqual(created.bytes, [0, 255, 128]);
  assert.equal(Object.isFrozen(created.bytes), true);
  assert.throws(() => { created.bytes[0] = 9; }, TypeError);
  const edit = [255, 0, 255];
  assert.equal(files.write("raw.bin", edit), true);
  edit[1] = 88;
  assert.equal(await files.save("raw.bin"), true);
  assert.deepEqual(f.disk.get("/book/raw.bin"), [255, 0, 255]);
  assert.equal(files.write("raw.bin", [256]), false);
  assert.equal(await files.create("invalid.bin", [-1]), null);
  assert.equal(f.disk.has("/book/invalid.bin"), false);
  await controller.dispose();
});

test("a native read with invalid bytes keeps the previously loaded snapshot", async () => {
  const f = byteStorageFixture();
  f.disk.set("/book/chapter.bin", [0, 255, 128]);
  const controller = f.files();
  const files = controller.service;
  const original = await files.read("chapter.bin");
  f.disk.set("/book/chapter.bin", [0, 256, 128]);

  assert.equal(await files.read("chapter.bin"), null);
  assert.strictEqual(files.getSnapshot().files[0], original);
  assert.deepEqual(original.bytes, [0, 255, 128]);
  assert.match(files.getSnapshot().error, /字节/);
  await controller.dispose();
});

test("native read and create isolate their response arrays and install the same validated canonical bytes", async () => {
  const nativeBytes = new Map([["read.bin", [0, 255, 128]], ["create.bin", [128, 255, 0]]]);
  const f = createMainFixture({invokeHandler(command, args) {
    assert.ok(["read_project_file", "create_project_file"].includes(command));
    return {path: args.path, fileName: args.path, bytes: nativeBytes.get(args.path)};
  }});
  const bytes = f.loadModule("plugins/project-storage/bytes.ts");
  const copy = bytes.copyBytes;
  const copyAsync = bytes.copyBytesAsync;
  const copies = [];
  bytes.copyBytes = input => {
    const result = copy(input);
    copies.push({input, result});
    return result;
  };
  bytes.copyBytesAsync = async input => {
    const result = await copyAsync(input);
    copies.push({input, result});
    return result;
  };
  const controller = f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles("/book");
  try {
    const read = await controller.service.read("read.bin");
    const created = await controller.service.create("create.bin", [128, 255, 0]);
    for (const file of [read, created]) {
      const original = nativeBytes.get(file.path);
      const normalization = copies.find(call => call.input === original);
      assert.ok(normalization, "native bytes are copied and validated at the boundary");
      assert.notStrictEqual(normalization.result, original);
      assert.strictEqual(file.bytes, normalization.result, "the buffer installs the canonical bytes without another full copy");
      assert.ok(copies.some(call => call.input === file.bytes && call.result === file.bytes), "FileSession can reuse only already owned immutable bytes");
      const expected = [...file.bytes];
      original.fill(7);
      assert.deepEqual(file.bytes, expected, "later mutation of the native response cannot change a buffer");
      assert.equal(Object.isFrozen(file.bytes), true);
    }
  } finally {
    bytes.copyBytes = copy;
    bytes.copyBytesAsync = copyAsync;
    await controller.dispose();
  }
});

test("malformed native read and create records never install or replace a canonical buffer", async () => {
  let malformed = null;
  const f = createMainFixture({invokeHandler(command, args) {
    assert.ok(["read_project_file", "create_project_file"].includes(command));
    const record = {path: args.path, fileName: args.path, bytes: [0, 255]};
    return malformed ? malformed(record) : record;
  }});
  const controller = f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles("/book");
  const files = controller.service;
  try {
    const original = await files.read("kept.bin");
    for (const badRecord of [
      () => null,
      record => ({...record, path: "other.bin"}),
      record => ({...record, fileName: "other.bin"}),
      record => ({...record, bytes: new Uint8Array([0, 255])}),
      record => ({...record, bytes: [0, 256]}),
    ]) {
      malformed = badRecord;
      assert.equal(await files.read("kept.bin"), null);
      assert.strictEqual(files.getSnapshot().files[0], original);
      assert.equal(await files.create("new.bin", [0, 255]), null);
      assert.deepEqual(Array.from(files.getSnapshot().files, file => file.path), ["kept.bin"]);
      assert.ok(files.getSnapshot().error);
    }
  } finally {
    await controller.dispose();
  }
});

function pauseLargeNormalization(f) {
  const bytes = f.loadModule("plugins/project-storage/bytes.ts");
  const original = bytes.copyBytesAsync;
  const entered = deferred();
  const release = deferred();
  let closed = 0;
  bytes.copyBytesAsync = input => original(input, {schedulerFactory() {
    let paused = false;
    let clock = 0;
    return {
      now: () => clock++,
      yieldTask() {
        if (!paused) { paused = true; entered.resolve(); return release.promise; }
        return Promise.resolve();
      },
      close() { closed++; },
    };
  }});
  return {entered: entered.promise, release: () => release.resolve(), closed: () => closed,
    restore() { bytes.copyBytesAsync = original; }};
}

test("concurrent reads share the same large normalization and native read", async () => {
  const fixture = byteStorageFixture();
  fixture.disk.set("/book/large.bin", Array.from({length: 65_537}, (_value, index) => index % 256));
  const pause = pauseLargeNormalization(fixture.f);
  const controller = fixture.files();
  try {
    const first = controller.service.read("large.bin");
    await pause.entered;
    assert.equal(controller.service.getSnapshot().files.length, 0, "partial bytes are not published");

    const second = controller.service.read("large.bin");
    assert.strictEqual(second, first, "a read during normalization joins the opening operation");
    assert.equal(fixture.calls.filter(call => call.command === "read_project_file").length, 1);

    pause.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(firstResult, secondResult);
    assert.strictEqual(controller.service.getSnapshot().files[0], firstResult);
    assert.equal(firstResult.bytes.length, 65_537);
    assert.equal(firstResult.bytes[65_536], 0);
    assert.equal(Object.isFrozen(firstResult.bytes), true);
    assert.equal(pause.closed(), 1);
  } finally { pause.release(); pause.restore(); await controller.dispose(); }
});

test("leave waits for full large-byte normalization and captures native metadata and data before yielding", async () => {
  const response = {path: "large.bin", fileName: "large.bin", bytes: Array.from({length: 65_537}, (_, index) => index % 256)};
  const f = createMainFixture({invokeHandler(command) {
    assert.equal(command, "read_project_file");
    return response;
  }});
  const pause = pauseLargeNormalization(f);
  const controller = f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles("/book");
  try {
    const reading = controller.service.read("large.bin");
    await pause.entered;
    assert.equal(controller.service.getSnapshot().files.length, 0, "partial arrays are never published");
    response.path = "changed.bin"; response.fileName = "changed.bin"; response.bytes.fill(9);
    let left = false;
    const leaving = controller.beginLeave().then(value => { left = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(left, false, "accepted normalization belongs to the storage pending queue");
    assert.equal(controller.service.getSnapshot().blocked, true);
    pause.release();
    const file = await reading;
    assert.equal(await leaving, true);
    assert.equal(file.path, "large.bin");
    assert.equal(file.fileName, "large.bin");
    assert.equal(file.bytes[0], 0);
    assert.equal(file.bytes[65_536], 0);
    assert.equal(Object.isFrozen(file.bytes), true);
    assert.equal(pause.closed(), 1);
  } finally { pause.release(); pause.restore(); await controller.dispose(); }
});

test("disposing during large-byte normalization drains work and never installs the abandoned read", async () => {
  const fixture = byteStorageFixture();
  fixture.disk.set("/book/large.bin", Array(65_537).fill(1));
  const pause = pauseLargeNormalization(fixture.f);
  const controller = fixture.files();
  try {
    const reading = controller.service.read("large.bin");
    await pause.entered;
    let stopped = false;
    const stopping = controller.dispose().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(stopped, false);
    pause.release();
    assert.equal(await reading, null);
    await stopping;
    assert.equal(controller.service.getSnapshot().files.length, 0);
    assert.equal(controller.service.getSnapshot().blocked, true);
    assert.equal(pause.closed(), 1);
  } finally { pause.release(); pause.restore(); await controller.dispose(); }
});

test("edits made during a large clean refresh retain their old conflict baseline", async () => {
  const fixture = byteStorageFixture();
  fixture.disk.set("/book/large.bin", [0, 255]);
  const controller = fixture.files();
  const files = controller.service;
  await files.read("large.bin");
  const pause = pauseLargeNormalization(fixture.f);
  fixture.disk.set("/book/large.bin", Array(65_537).fill(1));
  try {
    const refreshing = files.read("large.bin");
    await pause.entered;
    assert.equal(files.write("large.bin", [99, 128]), true);
    const edited = files.getSnapshot().files[0];
    pause.release();
    assert.strictEqual(await refreshing, edited, "refresh never replaces a newly dirty buffer");
    assert.equal(await files.save("large.bin"), false, "external disk changes still cause a conflict");
    assert.deepEqual(Array.from(files.getSnapshot().files[0].bytes), [99, 128]);
    assert.equal(files.getSnapshot().files[0].saveState, "error");
    assert.equal(fixture.disk.get("/book/large.bin").length, 65_537);
    await assert.rejects(controller.dispose(), error => {
      assert.deepEqual(Array.from(error.snapshot.files[0].bytes), [99, 128]);
      return true;
    });
  } finally { pause.release(); pause.restore(); }
});

test("an accepted large create finishes normalization before leave and preserves captured caller bytes", async () => {
  const fixture = byteStorageFixture();
  const pause = pauseLargeNormalization(fixture.f);
  const controller = fixture.files();
  const input = Array(65_537).fill(7);
  try {
    const creating = controller.service.create("large.bin", input);
    input.fill(9);
    await pause.entered;
    assert.equal(fixture.disk.get("/book/large.bin")[0], 7, "native create accepted the original bytes");
    assert.equal(controller.service.getSnapshot().files.length, 0);
    let left = false;
    const leaving = controller.beginLeave().then(result => { left = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(left, false);
    pause.release();
    const created = await creating;
    assert.equal(created.bytes[0], 7);
    assert.equal(Object.isFrozen(created.bytes), true);
    assert.equal(await leaving, true);
    assert.equal(pause.closed(), 1);
  } finally { pause.release(); pause.restore(); await controller.dispose(); }
});

test("an invalid large create response releases its path and can be retried without publishing partial bytes", async () => {
  const persisted = new Map();
  const nativeCalls = [];
  let returnMalformedResponse = true;
  const f = createMainFixture({invokeHandler(command, args) {
    assert.equal(command, "create_project_file");
    nativeCalls.push(args);
    const current = persisted.get(args.path);
    if (current) {
      assert.equal(args.acceptIdentical, true, "retry explicitly accepts only the identical existing file");
      assert.deepEqual(args.bytes, current);
    } else {
      persisted.set(args.path, [...args.bytes]);
    }
    const responseBytes = [...persisted.get(args.path)];
    if (returnMalformedResponse) {
      returnMalformedResponse = false;
      responseBytes[4_500] = 256;
    }
    return {path: args.path, fileName: args.path, bytes: responseBytes};
  }});
  const pause = pauseLargeNormalization(f);
  const controller = f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles("/book");
  const input = Array(65_537).fill(7);
  try {
    const firstCreate = controller.service.create("large.bin", input);
    await pause.entered;
    assert.equal(controller.service.getSnapshot().files.length, 0, "partial response bytes are never published");
    pause.release();

    assert.equal(await firstCreate, null);
    assert.match(controller.service.getSnapshot().error, /字节/);
    assert.equal(controller.service.getSnapshot().files.length, 0);
    assert.equal(persisted.get("large.bin").length, 65_537, "the native create is present with the original valid input");
    assert.equal(pause.closed(), 1, "the failed async normalization closes its scheduler");

    const retry = await controller.service.create("large.bin", input, {acceptIdentical: true});
    assert.ok(retry, "the same path is no longer left in the changing state");
    assert.equal(retry.bytes.length, 65_537);
    assert.equal(retry.bytes[4_500], 7);
    assert.equal(Object.isFrozen(retry.bytes), true);
    assert.deepEqual(Array.from(controller.service.getSnapshot().files, file => file.path), ["large.bin"]);
    assert.equal(nativeCalls.length, 2);
    assert.equal(pause.closed(), 2);
  } finally { pause.release(); pause.restore(); await controller.dispose(); }
});

test("reading a file while its save is in progress reuses the protected buffer", async () => {
  const entered = deferred();
  const release = deferred();
  const f = byteStorageFixture({async onInvoke(command) {
    if (command === "save_project_file") { entered.resolve(); await release.promise; }
  }});
  f.disk.set("/book/chapter.bin", [0, 255]);
  const controller = f.files();
  const files = controller.service;
  await files.read("chapter.bin");
  files.write("chapter.bin", [128, 0, 255]);
  const saving = files.save("chapter.bin");
  await entered.promise;

  const duringSave = files.getSnapshot().files[0];
  assert.equal(duringSave.saveState, "saving");
  assert.strictEqual(await files.read("chapter.bin"), duringSave);
  assert.equal(f.calls.filter(call => call.command === "read_project_file").length, 1);
  release.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(f.disk.get("/book/chapter.bin"), [128, 0, 255]);
  await controller.dispose();
});

test("idempotent create is an explicit byte comparison and never overwrites different contents", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const files = controller.service;
  const path = ".caller-chosen/files/record.data";
  assert.ok(await files.create(path, [255, 0], {createParents: true}));
  assert.equal(await files.create(path, [255, 0]), null);
  assert.ok(await files.create(path, [255, 0], {acceptIdentical: true}));
  assert.equal(await files.create(path, [0], {acceptIdentical: true}), null);
  assert.deepEqual(f.disk.get(`/book/${path}`), [255, 0]);
  await controller.dispose();
});

test("storage dispose reentry shares its promise before subscribers are notified", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  await controller.service.create("one.bin", [1]);
  let nested;
  controller.service.subscribe(() => { if (controller.service.getSnapshot().blocked) nested = controller.dispose(); });
  const disposal = controller.dispose();
  assert.strictEqual(nested, disposal);
  await disposal;
});
