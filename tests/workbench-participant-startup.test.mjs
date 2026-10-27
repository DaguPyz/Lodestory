import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

async function waitFor(predicate, message) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function viewSessions(layout, id) {
  const entry = layout.getSnapshot().contents.find(content => content.id === id);
  assert.ok(entry, `expected layout contribution ${id}`);
  return entry.render({active: false}).props.sessions;
}

const project = {id: "startup-test", name: "启动测试", path: "/projects/startup-test"};

function assetStoreMock(loadGate, loadStarted, records) {
  return {
    createAssetSchemaStore() {
      const snapshot = {types: [], assets: [], fields: [], loaded: false, loading: true, error: null, blocked: false};
      const record = {disposed: false};
      records.push(record);
      return {
        getSnapshot() { return snapshot; },
        subscribe() { return () => {}; },
        async load() {
          loadStarted.resolve();
          const outcome = await loadGate.promise;
          snapshot.loading = false;
          if (outcome === false) {
            snapshot.error = "资产目录无法读取。";
            return false;
          }
          snapshot.loaded = true;
          return true;
        },
        async retry() { return false; },
        dispose() { record.disposed = true; },
      };
    },
  };
}

function timelineModelMock(loadGate, loadStarted, records) {
  return {
    createTimelineListModel() {
      const snapshot = {entries: [], selectedId: null, createDraft: null, loaded: false, loading: true,
        busy: false, error: null, issues: []};
      const record = {disposed: false};
      records.push(record);
      return {
        getSnapshot() { return snapshot; },
        subscribe() { return () => {}; },
        async load() {
          loadStarted.resolve();
          const outcome = await loadGate.promise;
          snapshot.loading = false;
          if (outcome === false) {
            snapshot.error = "时间线目录无法读取。";
            return false;
          }
          snapshot.loaded = true;
          return true;
        },
        dispose() { record.disposed = true; },
      };
    },
  };
}

async function beginProject(fixture) {
  fixture.start();
  await flushStartup();
  const workbench = fixture.getService(fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const layout = fixture.getService(fixture.requireSdk("@lodestory/sdk/layout").layoutKey);
  const opening = workbench.openProject(project);
  return {workbench, layout, opening};
}

test("asset startup keeps its catalog and session map private until load succeeds", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/asset-management/assetSchemaStore.ts": assetStoreMock(gate, loadStarted, records),
  }});
  const {workbench, layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "asset-management.navigation");
  const catalog = fixture.getService(fixture.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey);

  await loadStarted.promise;
  assert.equal(sessions.size, 0, "the pending store is not exposed to a mounted view");
  assert.equal(catalog.getCatalog(workbench.getSnapshot().session.id), null,
    "the pending catalog is not exposed through the public capability");
  gate.resolve(true);
  await opening;
  await waitFor(() => sessions.size === 1, "the initialized asset resource was not published");
  assert.equal(sessions.size, 1, "the initialized resource becomes visible after startup completes");
  assert.equal(records[0].disposed, false);
  await fixture.createdCores.at(-1).unmountAll();
});

test("asset startup failure disposes its unpublished store and reports an error", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/asset-management/assetSchemaStore.ts": assetStoreMock(gate, loadStarted, records),
  }});
  const {workbench, layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "asset-management.navigation");
  await loadStarted.promise;
  assert.equal(sessions.size, 0);
  gate.resolve(false);
  await opening;
  const failure = await waitFor(() => workbench.getSnapshot().loading?.error,
    "a false asset load result did not reach workbench recovery");
  assert.equal(failure.message, "资产目录无法读取。");
  assert.equal(sessions.size, 0, "failed startup remains unpublished");
  assert.equal(records[0].disposed, true, "failed startup disposes the schema store");
  await fixture.createdCores.at(-1).unmountAll();
});

test("asset deactivation during pending startup waits for cleanup without publishing the resource", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/asset-management/assetSchemaStore.ts": assetStoreMock(gate, loadStarted, records),
  }});
  const {layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "asset-management.navigation");
  await loadStarted.promise;
  assert.equal(sessions.size, 0);
  const unmounting = fixture.createdCores.at(-1).unmountAll();
  gate.resolve(true);
  await unmounting;
  await opening;
  assert.equal(sessions.size, 0, "a stopped plugin never publishes its pending resource");
  assert.equal(records[0].disposed, true, "resources created during deactivation are cleaned up");
  await fixture.createdCores.at(-1).unmountAll();
});

test("timeline startup keeps its public model private until the initial read succeeds", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/timeline/timelineListModel.ts": timelineModelMock(gate, loadStarted, records),
  }});
  const {workbench, layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "timeline.main");
  const timeline = fixture.getService(fixture.requireSdk("@lodestory/sdk/timeline").timelineKey);
  await loadStarted.promise;
  const sessionId = workbench.getSnapshot().session.id;
  assert.equal(sessions.size, 0, "the pending timeline resources are not exposed to a view");
  assert.equal(timeline.getModel(sessionId), null, "the pending timeline model is not public");
  gate.resolve(true);
  await opening;
  await waitFor(() => !workbench.getSnapshot().busy, "timeline startup did not finish");
  assert.equal(sessions.size, 1);
  assert.ok(timeline.getModel(sessionId), "the model is exposed after its initial read settles successfully");
  assert.equal(records[0].disposed, false);
  await fixture.createdCores.at(-1).unmountAll();
});

test("timeline load failure disposes its unpublished model and reports a workbench error", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/timeline/timelineListModel.ts": timelineModelMock(gate, loadStarted, records),
  }});
  const {workbench, layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "timeline.main");
  await loadStarted.promise;
  const sessionId = workbench.getSnapshot().session.id;
  assert.equal(sessions.size, 0);
  gate.resolve(false);
  await opening;
  const failure = await waitFor(() => workbench.getSnapshot().loading?.error,
    "a false timeline load result did not reach workbench recovery");
  assert.equal(failure.message, "时间线目录无法读取。");
  assert.equal(sessions.size, 0, "failed startup remains unpublished");
  assert.equal(records[0].disposed, true, "failed startup disposes the timeline model");
  const timeline = fixture.getService(fixture.requireSdk("@lodestory/sdk/timeline").timelineKey);
  assert.equal(timeline.getModel(sessionId), null, "failed timeline model remains private");
  await fixture.createdCores.at(-1).unmountAll();
});

test("timeline deactivation during pending startup keeps unpublished resources isolated and disposes them", async () => {
  const gate = deferred();
  const loadStarted = deferred();
  const records = [];
  const fixture = createMainFixture({moduleMocks: {
    "plugins/timeline/timelineListModel.ts": timelineModelMock(gate, loadStarted, records),
  }});
  const {workbench, layout, opening} = await beginProject(fixture);
  const sessions = viewSessions(layout, "timeline.main");
  await loadStarted.promise;
  assert.equal(sessions.size, 0);
  const unmounting = fixture.createdCores.at(-1).unmountAll();
  gate.resolve(true);
  await unmounting;
  await opening;
  assert.equal(sessions.size, 0, "failed or stopped timeline startup stays unpublished");
  assert.equal(records[0].disposed, true, "failed timeline startup disposes the list model");
  await fixture.createdCores.at(-1).unmountAll();
});
