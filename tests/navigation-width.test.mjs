import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/plugins/default-layout/navigationWidth.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const module = {exports: {}};
vm.runInNewContext(compiled, {exports: module.exports, module, require});
const {createNavigationWidthModel, navigationWidthConfig} = module.exports;

function createConfigService({
  baseValue = navigationWidthConfig.defaultValue,
  initialValue = baseValue,
} = {}) {
  let value = initialValue;
  let snapshotReads = 0;
  const listeners = new Set();
  const registered = new Set();
  const writes = [];
  return {
    writes,
    registered,
    get snapshotReads() { return snapshotReads; },
    register(item) {
      registered.add(item);
      return () => registered.delete(item);
    },
    getSnapshot(item) {
      snapshotReads += 1;
      return registered.has(item) ? value : item.defaultValue;
    },
    async set(item, next) {
      assert.equal(registered.has(item), true);
      assert.equal(item.validate(next), true);
      writes.push(["set", next]);
      const changed = value !== next;
      value = next;
      if (changed) for (const listener of [...listeners]) listener();
    },
    async reset(item) {
      assert.equal(registered.has(item), true);
      writes.push(["reset"]);
      const changed = value !== baseValue;
      value = baseValue;
      if (changed) for (const listener of [...listeners]) listener();
    },
    subscribe(item, listener) {
      assert.equal(registered.has(item), true);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deferConfigWrites(config, {failValues = new Set()} = {}) {
  const queued = [];
  const set = config.set.bind(config);
  const reset = config.reset.bind(config);
  config.set = (item, value) => new Promise((resolve, reject) => {
    queued.push(async () => {
      if (failValues.has(value)) {
        reject(new Error(`config write failed for ${value}`));
        return;
      }
      try { await set(item, value); resolve(); }
      catch (error) { reject(error); }
    });
  });
  config.reset = item => new Promise((resolve, reject) => {
    queued.push(async () => {
      try { await reset(item); resolve(); }
      catch (error) { reject(error); }
    });
  });
  return {
    queued,
    async settleNext() {
      const settle = queued.shift();
      assert.ok(settle, "expected a queued config write");
      await settle();
    },
  };
}

test("preferred width survives environment changes while effective width is clamped", async () => {
  const config = createConfigService();
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});
  assert.equal(model.getSnapshot().effectiveWidth, 256);

  model.previewWidth(420);
  await model.commitWidth();
  assert.equal(model.getSnapshot().preferredWidth, 420);
  assert.equal(model.getSnapshot().effectiveWidth, 420);
  assert.deepEqual(config.writes, [["set", 420]]);

  model.setEnvironment({availableWidth: 300, defaultWidth: 260});
  assert.equal(model.getSnapshot().preferredWidth, 420);
  assert.equal(model.getSnapshot().effectiveWidth, 300);
  model.setEnvironment({availableWidth: 700, defaultWidth: 260});
  assert.equal(model.getSnapshot().preferredWidth, 420);
  assert.equal(model.getSnapshot().effectiveWidth, 420);
  model.dispose();
});

test("preview is transient, cancel restores the preference, and reset follows the measured default", async () => {
  const config = createConfigService();
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});

  model.previewWidth(390);
  assert.equal(model.getSnapshot().effectiveWidth, 390);
  assert.deepEqual(config.writes, []);
  model.cancelPreview();
  assert.equal(model.getSnapshot().effectiveWidth, 256);

  model.previewWidth(390);
  await model.commitWidth();
  model.setEnvironment({availableWidth: 600, defaultWidth: 270});
  assert.equal(model.getSnapshot().effectiveWidth, 390);
  await model.reset();
  assert.equal(model.getSnapshot().preferredWidth, null);
  assert.equal(model.getSnapshot().effectiveWidth, 270);
  assert.deepEqual(config.writes, [["set", 390], ["reset"]]);
  model.dispose();
});

test("small available space collapses the bounds but commits a canonical preference", async () => {
  const config = createConfigService();
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 150, defaultWidth: 256});
  assert.equal(model.getSnapshot().minWidth, 150);
  assert.equal(model.getSnapshot().maxWidth, 150);
  assert.equal(model.getSnapshot().effectiveWidth, 150);

  model.previewWidth(300);
  assert.equal(model.getSnapshot().effectiveWidth, 150);
  await model.commitWidth();
  assert.equal(model.getSnapshot().preferredWidth, 200);
  assert.equal(model.getSnapshot().effectiveWidth, 150);
  assert.deepEqual(config.writes, [["set", 200]]);
  model.dispose();
});

test("each layout runtime owns an independent config subscription and model", async () => {
  const firstConfig = createConfigService();
  const secondConfig = createConfigService();
  const first = createNavigationWidthModel(firstConfig);
  const second = createNavigationWidthModel(secondConfig);
  first.setEnvironment({availableWidth: 600, defaultWidth: 256});
  second.setEnvironment({availableWidth: 600, defaultWidth: 256});

  first.previewWidth(400);
  await first.commitWidth();
  assert.equal(first.getSnapshot().effectiveWidth, 400);
  assert.equal(second.getSnapshot().effectiveWidth, 256);
  first.dispose();
  assert.equal(firstConfig.registered.size, 0);
  assert.equal(secondConfig.registered.size, 1);
  second.setEnvironment({availableWidth: 600, defaultWidth: 280});
  assert.equal(second.getSnapshot().effectiveWidth, 280);
  second.dispose();
});

test("an older commit publish preserves a newer drag preview", async () => {
  const config = createConfigService();
  const writes = deferConfigWrites(config);
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});
  model.previewWidth(300);
  const saving = model.commitWidth();

  model.previewWidth(350);
  await writes.settleNext();
  await saving;
  assert.equal(model.getSnapshot().preferredWidth, 300);
  assert.equal(model.getSnapshot().effectiveWidth, 350);
  model.dispose();
});

test("rapid commits apply the final serialized preference without clearing newer intent", async () => {
  const config = createConfigService();
  const writes = deferConfigWrites(config);
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});

  model.previewWidth(300);
  const first = model.commitWidth();
  model.previewWidth(350);
  const second = model.commitWidth();
  assert.equal(writes.queued.length, 2);

  await writes.settleNext();
  await first;
  assert.equal(model.getSnapshot().preferredWidth, 350);
  assert.equal(model.getSnapshot().effectiveWidth, 350);
  await writes.settleNext();
  await second;
  assert.equal(model.getSnapshot().preferredWidth, 350);
  assert.equal(model.getSnapshot().effectiveWidth, 350);
  model.dispose();
});

test("an older successful commit cannot replace a newer failed commit", async () => {
  const config = createConfigService();
  const writes = deferConfigWrites(config, {failValues: new Set([350])});
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});

  model.previewWidth(300);
  const first = model.commitWidth();
  model.previewWidth(350);
  const second = model.commitWidth();

  await writes.settleNext();
  await first;
  assert.equal(model.getSnapshot().preferredWidth, 350);
  await writes.settleNext();
  await assert.rejects(second, /config write failed for 350/);
  assert.equal(model.getSnapshot().preferredWidth, 350);
  assert.equal(model.getSnapshot().effectiveWidth, 350);
  model.dispose();
});

test("reset rereads an unchanged non-null app default after persistence", async () => {
  const config = createConfigService({baseValue: 420, initialValue: 420});
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});
  model.previewWidth(420);
  await model.commitWidth();
  assert.equal(model.getSnapshot().preferredWidth, 420);

  await model.reset();
  // The fake config service emits no event when reset leaves the effective
  // value at 420, so the model must read the persisted value after awaiting.
  assert.equal(model.getSnapshot().preferredWidth, 420);
  assert.equal(model.getSnapshot().effectiveWidth, 420);
  model.dispose();
});

test("failed persistence keeps the current-session width and rejects to the caller", async () => {
  const config = createConfigService();
  const model = createNavigationWidthModel(config);
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});
  model.previewWidth(350);
  config.set = async () => { throw new Error("config write failed"); };
  await assert.rejects(model.commitWidth(), /config write failed/);
  assert.equal(model.getSnapshot().preferredWidth, 350);
  assert.equal(model.getSnapshot().effectiveWidth, 350);

  const resetConfig = createConfigService({initialValue: 390});
  const resetModel = createNavigationWidthModel(resetConfig);
  resetModel.setEnvironment({availableWidth: 600, defaultWidth: 256});
  resetConfig.reset = async () => { throw new Error("config reset failed"); };
  await assert.rejects(resetModel.reset(), /config reset failed/);
  assert.equal(resetModel.getSnapshot().preferredWidth, null);
  assert.equal(resetModel.getSnapshot().effectiveWidth, 256);
  model.dispose();
  resetModel.dispose();
});

test("pending writes and React cleanup are safe after model disposal", async () => {
  const config = createConfigService();
  const model = createNavigationWidthModel(config);
  let finishPersistence;
  const persistenceGate = new Promise(resolve => { finishPersistence = resolve; });
  const set = config.set.bind(config);
  config.set = async (item, value) => {
    // Start and validate the write while the config contribution is registered,
    // then hold its completion to model teardown during an in-flight persist.
    await set(item, value);
    await persistenceGate;
  };
  model.setEnvironment({availableWidth: 600, defaultWidth: 256});
  let notifications = 0;
  model.subscribe(() => { notifications += 1; });
  model.previewWidth(350);
  const saving = model.commitWidth();
  const notificationsAtDispose = notifications;
  model.dispose();
  const snapshotReadsAtDispose = config.snapshotReads;

  assert.doesNotThrow(() => model.cancelPreview());
  assert.doesNotThrow(() => model.setEnvironment({availableWidth: 300, defaultWidth: 250}));
  assert.doesNotThrow(() => model.subscribe(() => { notifications += 1; }));
  finishPersistence();
  await saving;

  assert.equal(config.snapshotReads, snapshotReadsAtDispose);
  assert.equal(notifications, notificationsAtDispose);
  assert.equal(config.registered.size, 0);
  assert.equal(model.getSnapshot().effectiveWidth, 350);
  await model.commitWidth();
  assert.equal(config.snapshotReads, snapshotReadsAtDispose);
});

test("config accepts only the follow-theme sentinel or an in-range preferred width", () => {
  assert.equal(navigationWidthConfig.validate(null), true);
  for (const width of [200, 256, 480]) assert.equal(navigationWidthConfig.validate(width), true);
  for (const width of [199, 481, Number.NaN, Number.POSITIVE_INFINITY, "256"]) {
    assert.equal(navigationWidthConfig.validate(width), false);
  }
});
