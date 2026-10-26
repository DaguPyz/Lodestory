import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";
import {deferred} from "./helpers/mainStartupFixture.mjs";

const source = await readFile(new URL("../src/plugins/timeline/timelineAxisStore.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const axisExports = {};
let onDecode = null;
class InstrumentedTextDecoder extends TextDecoder {
  decode(...args) {
    onDecode?.();
    return super.decode(...args);
  }
}
vm.runInNewContext(compiled, {
  exports: axisExports, TextDecoder: InstrumentedTextDecoder, TextEncoder, Uint8Array, Object, Array, Number, String,
  Set, Map, Promise, Error, RegExp, JSON, Math,
});
const {createTimelineAxisStore} = axisExports;

const id = "00000000-0000-4000-8000-000000000001";
const path = `.lodestory/timeline/axes/${id}.json`;
const directory = ".lodestory/timeline/axes";

function storeFor(files, timelineId = id) {
  return createTimelineAxisStore(files, timelineId);
}

function seedFile(f, targetPath, content) {
  f.disk.set(f.key("/book", targetPath), Array.from(new TextEncoder().encode(content)));
  const parts = targetPath.split("/");
  for (let index = 1; index < parts.length; index++) {
    f.directories.add(f.key("/book", parts.slice(0, index).join("/")));
  }
}

function storedAxis(patch = {}) {
  return {
    format: "lodestory.timeline-axis-settings",
    schemaVersion: 1,
    id,
    origin: 0,
    step: 5,
    unit: "天",
    ...patch,
  };
}

function statusAwareFiles(service, targetPath) {
  let statusOverride = null;
  const listeners = new Set();
  return {
    service: {
      getSnapshot() {
        const snapshot = service.getSnapshot();
        if (!statusOverride) return snapshot;
        const files = snapshot.files.map(file => file.path === targetPath
          ? Object.freeze({...file, dirty: statusOverride !== "saved", saveState: statusOverride,
            saveError: statusOverride === "error" ? "disk unavailable" : null})
          : file);
        return {...snapshot, files};
      },
      subscribe(listener) {
        listeners.add(listener);
        const unsubscribe = service.subscribe(() => { for (const current of [...listeners]) current(); });
        return () => { listeners.delete(listener); unsubscribe(); };
      },
      read: (...args) => service.read(...args),
      create: (...args) => service.create(...args),
      write: (...args) => service.write(...args),
      save: (...args) => service.save(...args),
      saveAll: (...args) => service.saveAll(...args),
      delete: (...args) => service.delete(...args),
      list: (...args) => service.list(...args),
      createDirectory: (...args) => service.createDirectory(...args),
      clearError: (...args) => service.clearError(...args),
    },
    setSaveState(state) {
      statusOverride = state;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("missing axis loads defaults without creating a file; settings persist and restore per timeline", async () => {
  const f = byteStorageFixture();
  const firstController = f.files();
  const first = storeFor(firstController.service);

  assert.equal(await first.load(), true);
  assert.deepEqual({...first.getSnapshot().settings}, {origin: 0, step: 5, unit: "天"});
  assert.equal(first.getSnapshot().loaded, true);
  assert.equal(firstController.service.getSnapshot().error, null, "missing settings are confirmed by listing without leaving a read error");
  assert.equal(f.disk.has(f.key("/book", path)), false, "loading a missing settings file stays read-only");
  assert.equal(f.calls.some(call => call.command === "create_project_file"), false);
  assert.equal(await first.retry(), true);
  assert.equal(f.disk.has(f.key("/book", path)), false, "retrying a successful missing-file load does not create defaults");

  assert.equal(await first.update({origin: -3.5, step: 2.25, unit: "小时"}), true);
  assert.equal(f.disk.has(f.key("/book", path)), true);
  const persisted = JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path)))));
  assert.deepEqual(persisted, storedAxis({origin: -3.5, step: 2.25, unit: "小时"}));

  first.dispose();
  await firstController.dispose();
  const reopenedController = f.files();
  const reopened = storeFor(reopenedController.service);
  assert.equal(await reopened.load(), true);
  assert.deepEqual({...reopened.getSnapshot().settings}, {origin: -3.5, step: 2.25, unit: "小时"});
  reopened.dispose();
  await reopenedController.dispose();
});

test("invalid settings report field ranges without changing the current setting", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();

  assert.equal(await store.update({origin: 1_000_000_001, step: 5, unit: "天"}), false);
  assert.match(store.getSnapshot().error, /原点数值.*不超过/);
  assert.deepEqual({...store.getSnapshot().settings}, {origin: 0, step: 5, unit: "天"});
  assert.equal(await store.update({origin: 0, step: 0, unit: "天"}), false);
  assert.match(store.getSnapshot().error, /刻度间隔.*范围/);
  assert.equal(await store.update({origin: 0, step: 5, unit: " 天"}), false);
  assert.match(store.getSnapshot().error, /trim/);
  store.dispose();
  await controller.dispose();
});

test("failed saves keep the shared dirty bytes and retry flushes them", async () => {
  let failSave = false;
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("磁盘暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.update({origin: 4, step: 0.5, unit: "年"});

  failSave = true;
  assert.equal(await store.update({origin: 8, step: 0.5, unit: "年"}), false, "update reports failure unless the shared buffer reaches disk");
  assert.equal(await store.retry(), false);
  const failedFile = controller.service.getSnapshot().files.find(file => file.path === path);
  assert.equal(failedFile.dirty, true);
  assert.equal(failedFile.saveState, "error");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(failedFile.bytes))), storedAxis({origin: 8, step: 0.5, unit: "年"}));
  assert.match(store.getSnapshot().error, /磁盘暂不可写/);

  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(controller.service.getSnapshot().files.find(file => file.path === path).dirty, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path))))), storedAxis({origin: 8, step: 0.5, unit: "年"}));
  store.dispose();
  await controller.dispose();
});

test("external file changes cause a conflict and keep the user's axis draft intact", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(storedAxis()));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const external = storedAxis({origin: 99});
  f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(external))));
  assert.equal(await store.update({origin: -12, step: 4, unit: "轮"}), false, "external conflict is reported by update");
  assert.equal(await store.retry(), false);
  assert.deepEqual({...store.getSnapshot().settings}, {origin: -12, step: 4, unit: "轮"});
  const buffered = controller.service.getSnapshot().files.find(file => file.path === path);
  assert.equal(buffered.dirty, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(buffered.bytes))), storedAxis({origin: -12, step: 4, unit: "轮"}));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path))))), external);
  f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedAxis()))));
  assert.equal(await store.retry(), true, "restoring the expected disk version lets the retained draft save");
  store.dispose();
  await controller.dispose();
});

test("failed first creation keeps a dirty local draft until retry creates the file", async () => {
  let failCreate = true;
  const f = byteStorageFixture({onInvoke(command) {
    if (failCreate && command === "create_project_file") throw new Error("目录暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.update({origin: -2.5, step: 0.25, unit: "小时"}), false);
  assert.equal(store.getSnapshot().pendingCreate, true);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().saveState, "error");
  assert.deepEqual({...store.getSnapshot().settings}, {origin: -2.5, step: 0.25, unit: "小时"});
  assert.match(store.getSnapshot().error, /目录暂不可写/);
  assert.equal(f.disk.has(f.key("/book", path)), false);

  failCreate = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().pendingCreate, false);
  assert.equal(store.getSnapshot().dirty, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path))))), storedAxis({origin: -2.5, step: 0.25, unit: "小时"}));
  store.dispose();
  await controller.dispose();
});

test("corrupt or invalid UTF-8 files are blocked and never overwritten", async t => {
  for (const [name, bytes] of [
    ["malformed JSON", Array.from(new TextEncoder().encode("{"))],
    ["invalid UTF-8", [0xff, 0xfe]],
    ["unsupported version", Array.from(new TextEncoder().encode(JSON.stringify(storedAxis({schemaVersion: 2}))))],
  ]) {
    await t.test(name, async () => {
      const f = byteStorageFixture();
      seedFile(f, path, "");
      f.disk.set(f.key("/book", path), bytes);
      const controller = f.files();
      const store = storeFor(controller.service);
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().blocked, true);
      const original = [...f.disk.get(f.key("/book", path))];
      assert.equal(await store.update({origin: 1, step: 1, unit: "天"}), false);
      assert.deepEqual(f.disk.get(f.key("/book", path)), original);
      assert.equal(f.calls.some(call => call.command === "create_project_file" || call.command === "save_project_file"), false);
      store.dispose();
      await controller.dispose();
    });
  }
});

test("retry reloads a clean malformed buffer after the disk file is repaired", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, "{");
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);

  f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedAxis({origin: 3.25, step: 0.5, unit: "天"})))));
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().loaded, true);
  assert.equal(store.getSnapshot().blocked, false);
  assert.deepEqual({...store.getSnapshot().settings}, {origin: 3.25, step: 0.5, unit: "天"});
  store.dispose();
  await controller.dispose();
});

test("a stored axis byte version is parsed once across notifications and read completion", async () => {
  const f = byteStorageFixture();
  const otherPath = ".lodestory/unrelated.json";
  seedFile(f, path, JSON.stringify(storedAxis({origin: 4})));
  seedFile(f, otherPath, "unrelated");
  const controller = f.files();
  const statusFiles = statusAwareFiles(controller.service, path);
  const store = storeFor(statusFiles.service);
  let decodeCount = 0;
  onDecode = () => { decodeCount++; };
  try {
    assert.equal(await store.load(), true);
    assert.equal(decodeCount, 1, "the subscription and read result share one parse");
    let notifications = 0;
    store.subscribe(() => { notifications++; });

    await controller.service.read(otherPath);
    assert.equal(decodeCount, 1, "an unrelated file update does not decode the stored axis again");
    assert.equal(notifications, 0, "an unrelated file update does not republish an unchanged axis snapshot");

    statusFiles.setSaveState("saving");
    assert.equal(decodeCount, 1, "a save-state notification with the same bytes does not reparse the axis");
    assert.equal(store.getSnapshot().saving, true, "save state still reaches the consumer");
    statusFiles.setSaveState("error");
    assert.equal(store.getSnapshot().error, "disk unavailable", "save errors still reach the consumer");
    statusFiles.setSaveState("saved");
    assert.equal(store.getSnapshot().error, null, "successful save clears the visible file error");
    assert.equal(decodeCount, 1);

    f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode("{")));
    await controller.service.read(path);
    assert.equal(decodeCount, 2, "an externally changed file is checked once when refreshed");
    assert.equal(await store.retry(), false);
    f.disk.set(f.key("/book", otherPath), Array.from(new TextEncoder().encode("changed")));
    await controller.service.read(otherPath);
    assert.equal(decodeCount, 2, "repeated notifications reuse the cached parse error");

    f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedAxis({origin: 9})))));
    assert.equal(await store.retry(), true);
    assert.equal(decodeCount, 3, "a repaired file with new bytes is parsed");
    assert.equal(store.getSnapshot().settings.origin, 9);
  } finally {
    onDecode = null;
    store.dispose();
    await controller.dispose();
  }
});

test("concurrent loads share one read and dispose invalidates an in-flight timeline switch", async () => {
  const entered = deferred();
  const release = deferred();
  let firstRead = true;
  const f = byteStorageFixture({async onInvoke(command) {
    if (command === "read_project_file" && firstRead) {
      firstRead = false;
      entered.resolve();
      await release.promise;
    }
  }});
  seedFile(f, path, JSON.stringify(storedAxis({origin: 14})));
  const controller = f.files();
  const store = storeFor(controller.service);
  let notifications = 0;
  store.subscribe(() => { notifications++; });

  const loading = store.load();
  assert.strictEqual(store.load(), loading, "concurrent loads use the same operation");
  await entered.promise;
  store.dispose();
  const beforeRelease = notifications;
  release.resolve();
  assert.equal(await loading, false);
  assert.equal(notifications, beforeRelease, "disposed stores ignore late completion notifications");
  assert.equal(store.getSnapshot().loading, false);
  await controller.dispose();
});

