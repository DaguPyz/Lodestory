import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";
import {deferred} from "./helpers/mainStartupFixture.mjs";

const source = await readFile(new URL("../src/plugins/timeline/timelineEventStore.ts", import.meta.url), "utf8");
const sameEventsSignature = "function sameEvents(left: readonly TimelineEvent[], right: readonly TimelineEvent[]): boolean {";
const instrumentedSource = source.replace(sameEventsSignature,
  `${sameEventsSignature}\n  globalThis.__timelineStoreTestStats.sameEventsCalls++;`);
assert.notEqual(instrumentedSource, source, "the event comparator instrumentation marker is present");
const compiled = ts.transpileModule(instrumentedSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const storeExports = {};
let onDecode = null;
const storeStats = {sameEventsCalls: 0};
class InstrumentedTextDecoder extends TextDecoder {
  decode(...args) {
    onDecode?.();
    return super.decode(...args);
  }
}
vm.runInNewContext(compiled, {
  exports: storeExports, TextDecoder: InstrumentedTextDecoder, TextEncoder, Uint8Array, Object, Array, Number, String,
  Set, Map, Promise, Error, RegExp, JSON, Math, __timelineStoreTestStats: storeStats,
});
const {createTimelineEventStore} = storeExports;

const timelineId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const nextEventId = "00000000-0000-4000-8000-000000000003";
const path = `.lodestory/timeline/events/${timelineId}.json`;
const directory = ".lodestory/timeline/events";

function storeFor(files, id = timelineId) {
  return createTimelineEventStore(files, id);
}

function seedFile(f, targetPath, content) {
  f.disk.set(f.key("/book", targetPath), Array.from(new TextEncoder().encode(content)));
  const parts = targetPath.split("/");
  for (let index = 1; index < parts.length; index++) {
    f.directories.add(f.key("/book", parts.slice(0, index).join("/")));
  }
}

function event(patch = {}) {
  return {id: eventId, title: "归乡", summary: "收到一封信", offset: 3.25, placement: "above", important: false, assetIds: [], ...patch};
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function storedEvents(events, patch = {}) {
  return {format: "lodestory.timeline-events", schemaVersion: 2, timelineId, events, ...patch};
}

function legacyStoredEvents(events) {
  return {format: "lodestory.timeline-events", schemaVersion: 1, timelineId, events};
}

function diskEvents(f) {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path)))));
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

test("missing event file loads an empty list without creating a file; CRUD persists and restores", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);

  assert.equal(await store.load(), true);
  assert.deepEqual([...store.getSnapshot().events], []);
  assert.equal(store.getSnapshot().loaded, true);
  assert.equal(controller.service.getSnapshot().error, null, "listing confirms absence without a failed read");
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.equal(f.calls.some(call => call.command === "create_project_file"), false);

  assert.equal(await store.upsert(event({title: "  归乡  "})), true);
  assert.deepEqual(diskEvents(f), storedEvents([event({title: "归乡"})]));
  assert.equal(await store.upsert(event({summary: "修改摘要", offset: -8.75, placement: "below", important: true})), true);
  assert.equal(await store.getSnapshot().events.length, 1, "upsert replaces matching ids");
  assert.equal(diskEvents(f).events[0].summary, "修改摘要");
  assert.equal(await store.upsert(event({id: nextEventId, title: "再次出发", offset: 1e-14})), true);
  assert.equal(diskEvents(f).events[1].offset, 1e-14, "small offsets retain their numeric precision");
  assert.equal(await store.remove(nextEventId), true);
  assert.equal(await store.remove(eventId), true);
  assert.deepEqual(diskEvents(f).events, [], "removing the last event persists an empty document");

  store.dispose();
  await controller.dispose();
});

test("asset associations roundtrip, and legacy version 1 events upgrade only on first mutation", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(legacyStoredEvents([{id: eventId, title: "归乡", summary: "收到一封信", offset: 3.25, placement: "above", important: false}])));
  const controller = f.files();
  const store = storeFor(controller.service);

  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().events), [event()]);
  assert.equal(diskEvents(f).schemaVersion, 1, "reading legacy data must not write or migrate it");
  const associated = event({assetIds: [nextEventId]});
  assert.equal(await store.upsert(associated), true);
  assert.deepEqual(diskEvents(f), storedEvents([associated]));

  store.dispose();
  await controller.dispose();
});

test("event color roundtrips, can be cleared, and rejects invalid values without overwriting", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.upsert(event({color: "#A1B2C3"})), true);
  assert.equal(diskEvents(f).events[0].color, "#a1b2c3");
  assert.equal(await store.upsert(event({color: "red"})), false);
  assert.equal(diskEvents(f).events[0].color, "#a1b2c3");
  store.dispose();
  const reopened = storeFor(controller.service);
  assert.equal(await reopened.load(), true);
  assert.equal(reopened.getSnapshot().events[0].color, "#a1b2c3");
  assert.equal(await reopened.upsert(event()), true);
  assert.equal("color" in diskEvents(f).events[0], false);
  reopened.dispose();
  await controller.dispose();
});

test("event validation keeps existing events and reports invalid UUID, title, summary and offsets", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.upsert(event());

  assert.equal(await store.upsert(event({id: "not-a-uuid"})), false);
  assert.match(store.getSnapshot().error, /UUID/);
  assert.equal(await store.upsert(event({title: "  "})), false);
  assert.match(store.getSnapshot().error, /标题/);
  assert.equal(await store.upsert(event({summary: "x".repeat(201)})), false);
  assert.match(store.getSnapshot().error, /摘要/);
  assert.equal(await store.upsert(event({offset: Infinity})), false);
  assert.match(store.getSnapshot().error, /有限数字/);
  assert.equal(await store.upsert(event({offset: 1_000_000_001})), false);
  assert.equal(await store.upsert(event({assetIds: ["not-a-uuid"]})), false);
  assert.match(store.getSnapshot().error, /关联资产编号/);
  assert.equal(await store.upsert(event({assetIds: [nextEventId, nextEventId]})), false);
  assert.match(store.getSnapshot().error, /关联资产编号/);
  assert.deepEqual(plain(store.getSnapshot().events), [event()]);

  store.dispose();
  await controller.dispose();
});

test("failed first creation retains a pending draft and retry creates the file", async () => {
  let failCreate = true;
  const f = byteStorageFixture({onInvoke(command) {
    if (failCreate && command === "create_project_file") throw new Error("事件目录暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();

  assert.equal(await store.upsert(event({offset: -4.5, assetIds: [nextEventId]})), false);
  assert.equal(store.getSnapshot().pendingCreate, true);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().saveState, "error");
  assert.match(store.getSnapshot().error, /事件目录暂不可写/);
  assert.deepEqual(plain(store.getSnapshot().events), [event({offset: -4.5, assetIds: [nextEventId]})]);
  assert.equal(f.disk.has(f.key("/book", path)), false);

  failCreate = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().pendingCreate, false);
  assert.equal(store.getSnapshot().dirty, false);
  assert.deepEqual(diskEvents(f), storedEvents([event({offset: -4.5, assetIds: [nextEventId]})]));
  store.dispose();
  await controller.dispose();
});

test("failed saves keep shared dirty bytes and retry flushes the latest event", async () => {
  let failSave = false;
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("磁盘暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.upsert(event());

  failSave = true;
  assert.equal(await store.upsert(event({offset: 11.125, summary: "最新草稿", assetIds: [nextEventId]})), false);
  assert.equal(await store.retry(), false);
  const buffered = controller.service.getSnapshot().files.find(file => file.path === path);
  assert.equal(buffered.dirty, true);
  assert.equal(buffered.saveState, "error");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(buffered.bytes))), storedEvents([event({offset: 11.125, summary: "最新草稿", assetIds: [nextEventId]})]));
  assert.match(store.getSnapshot().error, /磁盘暂不可写/);

  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(controller.service.getSnapshot().files.find(file => file.path === path).dirty, false);
  assert.deepEqual(diskEvents(f), storedEvents([event({offset: 11.125, summary: "最新草稿", assetIds: [nextEventId]})]));
  store.dispose();
  await controller.dispose();
});

test("unsupported or malformed files are preserved and never overwritten", async t => {
  for (const [name, content] of [
    ["malformed JSON", "{"],
    ["unsupported version", JSON.stringify(storedEvents([], {schemaVersion: 3}))],
    ["mismatched timeline id", JSON.stringify(storedEvents([], {timelineId: nextEventId}))],
    ["duplicate event ids", JSON.stringify(storedEvents([event(), event({title: "冲突事件"})]))],
  ]) {
    await t.test(name, async () => {
      const f = byteStorageFixture();
      seedFile(f, path, content);
      const original = [...f.disk.get(f.key("/book", path))];
      const controller = f.files();
      const store = storeFor(controller.service);
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().blocked, true);
      assert.equal(await store.upsert(event({title: "不应保存"})), false);
      assert.deepEqual(f.disk.get(f.key("/book", path)), original);
      assert.equal(f.calls.some(call => call.command === "create_project_file" || call.command === "save_project_file"), false);
      store.dispose();
      await controller.dispose();
    });
  }
});

test("version 2 files reject missing, invalid, or duplicate asset ids without overwriting", async t => {
  const withoutAssociations = {id: eventId, title: "归乡", summary: "收到一封信", offset: 3.25, placement: "above", important: false};
  for (const [name, candidate] of [
    ["missing assetIds", withoutAssociations],
    ["invalid asset id", event({assetIds: ["bad"]})],
    ["duplicate asset ids", event({assetIds: [nextEventId, nextEventId]})],
  ]) {
    await t.test(name, async () => {
      const f = byteStorageFixture();
      seedFile(f, path, JSON.stringify(storedEvents([candidate])));
      const original = [...f.disk.get(f.key("/book", path))];
      const controller = f.files();
      const store = storeFor(controller.service);
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().blocked, true);
      assert.deepEqual(f.disk.get(f.key("/book", path)), original);
      store.dispose();
      await controller.dispose();
    });
  }
});

test("retry rereads a clean malformed file after it is repaired", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, "{");
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);

  f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedEvents([event({offset: 0.0000001})])))));
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().loaded, true);
  assert.equal(store.getSnapshot().blocked, false);
  assert.deepEqual(plain(store.getSnapshot().events), [event({offset: 0.0000001})]);
  store.dispose();
  await controller.dispose();
});

test("a stored event byte version is parsed once across notifications and read completion", async () => {
  const f = byteStorageFixture();
  const otherPath = ".lodestory/unrelated.json";
  seedFile(f, path, JSON.stringify(storedEvents([event()])));
  seedFile(f, otherPath, "unrelated");
  const controller = f.files();
  const statusFiles = statusAwareFiles(controller.service, path);
  const store = storeFor(statusFiles.service);
  let decodeCount = 0;
  storeStats.sameEventsCalls = 0;
  onDecode = () => { decodeCount++; };
  try {
    assert.equal(await store.load(), true);
    assert.equal(decodeCount, 1, "the subscription and read result share one parse");
    assert.equal(storeStats.sameEventsCalls, 1, "initial events are compared once against the empty list");
    let notifications = 0;
    store.subscribe(() => { notifications++; });

    await controller.service.read(otherPath);
    assert.equal(decodeCount, 1, "an unrelated file update does not decode stored events again");
    assert.equal(notifications, 0, "an unrelated file update does not republish an unchanged event snapshot");

    statusFiles.setSaveState("saving");
    assert.equal(decodeCount, 1, "a save-state notification with the same bytes does not reparse events");
    assert.equal(store.getSnapshot().saving, true, "save state still reaches the consumer");
    statusFiles.setSaveState("error");
    assert.equal(store.getSnapshot().error, "disk unavailable", "save errors still reach the consumer");
    statusFiles.setSaveState("saved");
    assert.equal(store.getSnapshot().error, null, "successful save clears the visible file error");
    assert.equal(decodeCount, 1);
    assert.equal(storeStats.sameEventsCalls, 1, "save-state notifications do not recompare events");

    f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedEvents([event()]), null, 4))));
    await controller.service.read(path);
    assert.equal(decodeCount, 2, "a new immutable byte version is parsed");
    assert.equal(storeStats.sameEventsCalls, 2, "semantically unchanged events are compared once and retain their current reference");
    f.disk.set(f.key("/book", otherPath), Array.from(new TextEncoder().encode("another change")));
    await controller.service.read(otherPath);
    assert.equal(decodeCount, 2, "an unrelated update reuses the current parse result");
    assert.equal(storeStats.sameEventsCalls, 2, "the same parse-result and events-reference pair is compared only once");

    f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode("{")));
    await controller.service.read(path);
    assert.equal(decodeCount, 3, "an externally changed file is checked once when refreshed");
    assert.equal(store.getSnapshot().blocked, true);
    f.disk.set(f.key("/book", otherPath), Array.from(new TextEncoder().encode("changed")));
    await controller.service.read(otherPath);
    assert.equal(decodeCount, 3, "repeated notifications reuse the cached parse error");
    assert.equal(storeStats.sameEventsCalls, 2, "an invalid cached result does not compare the current event list");

    f.disk.set(f.key("/book", path), Array.from(new TextEncoder().encode(JSON.stringify(storedEvents([event({offset: 9})])))));
    assert.equal(await store.retry(), true);
    assert.equal(decodeCount, 4, "a repaired file with new bytes is parsed");
    assert.equal(storeStats.sameEventsCalls, 3, "changed event contents are compared and adopted once");
    assert.equal(store.getSnapshot().events[0].offset, 9);
  } finally {
    onDecode = null;
    store.dispose();
    await controller.dispose();
  }
});

test("shared ProjectFiles bytes stay canonical and concurrent mutations cannot overwrite one another", async () => {
  const entered = deferred();
  const release = deferred();
  let pauseSave = false;
  let shouldPause = true;
  const f = byteStorageFixture({async onInvoke(command) {
    if (pauseSave && shouldPause && command === "save_project_file") {
      shouldPause = false;
      entered.resolve();
      await release.promise;
    }
  }});
  const controller = f.files();
  const first = storeFor(controller.service);
  await first.load();
  await first.upsert(event());
  const second = storeFor(controller.service);
  assert.equal(await second.load(), true);
  assert.deepEqual(plain(second.getSnapshot().events), [event()]);

  pauseSave = true;
  const pending = first.upsert(event({assetIds: [nextEventId]}));
  await entered.promise;
  assert.equal(await first.upsert(event({id: nextEventId, title: "不覆盖"})), false);
  assert.deepEqual(plain(second.getSnapshot().events[0].assetIds), [nextEventId], "a change to associations alone reaches subscribers through shared bytes");
  release.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(diskEvents(f), storedEvents([event({assetIds: [nextEventId]})]));

  first.dispose();
  second.dispose();
  await controller.dispose();
});

test("dispose cancels in-flight loading notifications and mutations", async () => {
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
  seedFile(f, path, JSON.stringify(storedEvents([event()])));
  const controller = f.files();
  const store = storeFor(controller.service);
  let notifications = 0;
  store.subscribe(() => { notifications++; });
  const loading = store.load();
  await entered.promise;
  store.dispose();
  const beforeRelease = notifications;
  release.resolve();
  assert.equal(await loading, false);
  assert.equal(notifications, beforeRelease);
  assert.equal(store.getSnapshot().loading, false);
  assert.equal(await store.upsert(event({offset: 12})), false);
  await controller.dispose();
});
