import assert from "node:assert/strict";
import test from "node:test";
import {deferred, flushStartup} from "./helpers/mainStartupFixture.mjs";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

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
  assert.equal(await documents.getWorkspace(workbench.getSnapshot().session.id).open("未完成写入.md"), true);
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
