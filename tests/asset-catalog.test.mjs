import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function fixture() {
  const stores = [];
  function createAssetSchemaStore(files) {
    const snapshot = {
      types: [], assets: [], fields: [], selectedTypeId: null, selectedAssetId: null, loaded: false, loading: true, saving: false,
      dirty: false, blocked: false, error: null, saveState: "saved",
    };
    const listeners = new Set();
    const record = {files, snapshot, listeners, retryCalls: 0, disposed: false};
    const store = {
      getSnapshot() { return snapshot; },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish() { for (const listener of [...listeners]) listener(); },
      async load() {
        snapshot.loading = false;
        snapshot.loaded = true;
        store.publish();
        return true;
      },
      async retry() { record.retryCalls++; return true; },
      dispose() { record.disposed = true; },
    };
    record.store = store;
    stores.push(record);
    return store;
  }

  const AssetTypeNavigation = function AssetTypeNavigation() {};
  const AssetTypeEditor = function AssetTypeEditor() {};
  const AssetRecordsEditor = function AssetRecordsEditor() {};
  const f = createMainFixture({moduleMocks: {
    "plugins/asset-management/assetSchemaStore.ts": {createAssetSchemaStore},
    "plugins/asset-management/AssetManagementView.tsx": {AssetTypeNavigation, AssetTypeEditor},
    "./AssetRecordsView": {AssetRecordsEditor},
  }});
  return {f, stores};
}

const project = {id: "catalog-book", name: "目录测试", path: "/projects/catalog-book"};

async function openReadyProject(workbench, target) {
  assert.equal(await workbench.openProject(target), true);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const snapshot = workbench.getSnapshot();
    if (snapshot.loading?.error) assert.fail(snapshot.loading.error.message);
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("workbench startup did not settle");
}

test("asset catalog uses one shared SDK key and publishes an immutable metadata-only projection", async () => {
  const {f, stores} = fixture();
  const contract = f.requireSdk("@lodestory/sdk/asset-catalog");
  assert.strictEqual(f.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey, contract.assetCatalogKey,
    "repeated subpath imports use the same shared key instance");
  f.start(); await flushStartup();

  const plugin = f.loadModule("plugins/asset-management/assetManagementPlugin.tsx").createAssetManagementPlugin();
  assert.strictEqual(plugin.provides[0], contract.assetCatalogKey);
  const service = f.getService(contract.assetCatalogKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const opened = await openReadyProject(workbench, project);
  const sessionId = opened.session.id;
  const catalog = service.getCatalog(sessionId);
  assert.ok(catalog);
  assert.equal(catalog.getSnapshot().loaded, true);

  const typeId = "40000000-0000-4000-8000-000000000001";
  const archivedTypeId = "40000000-0000-4000-8000-000000000003";
  const assetId = "40000000-0000-4000-8000-000000000002";
  const unclassifiedAssetId = "40000000-0000-4000-8000-000000000004";
  stores[0].snapshot.types = [
    {id: typeId, name: "人物", description: "内部描述", order: 0, status: "active"},
    {id: archivedTypeId, name: "旧地点", description: "已归档", order: 1, status: "archived"},
  ];
  stores[0].snapshot.assets = [
    {id: assetId, name: "林舟", description: "主角", typeId, values: {secret: "私有属性"}},
    {id: unclassifiedAssetId, name: "旧物件", description: "未分类", typeId: null, values: {}},
  ];
  stores[0].store.publish();

  const first = catalog.getSnapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(first.types)), [
    {id: typeId, name: "人物", status: "active"},
    {id: archivedTypeId, name: "旧地点", status: "archived"},
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(first.assets)), [
    {id: assetId, name: "林舟", description: "主角", typeId},
    {id: unclassifiedAssetId, name: "旧物件", description: "未分类", typeId: null},
  ]);
  assert.equal(Object.hasOwn(first.assets[0], "values"), false, "the catalog never exposes private asset property values");
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.types) && Object.isFrozen(first.types[0]));
  assert.ok(Object.isFrozen(first.assets) && Object.isFrozen(first.assets[0]));
  assert.strictEqual(catalog.getSnapshot(), first, "unchanged reads return a stable snapshot reference");

  let notifications = 0;
  const unsubscribe = catalog.subscribe(() => { notifications++; });
  stores[0].snapshot.assets = stores[0].snapshot.assets.map(asset => ({...asset, values: {secret: "修改私有属性"}}));
  stores[0].store.publish();
  assert.strictEqual(catalog.getSnapshot(), first, "private property edits leave the public metadata snapshot stable");
  assert.equal(notifications, 0, "private property edits do not notify catalog consumers");
  stores[0].snapshot.types = [{...stores[0].snapshot.types[0], name: "人物角色"}];
  stores[0].store.publish();
  const renamed = catalog.getSnapshot();
  assert.notStrictEqual(renamed, first);
  assert.equal(renamed.types[0].name, "人物角色");
  assert.equal(notifications, 1, "a relevant schema rename notifies catalog consumers");
  unsubscribe();
  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("catalogs are isolated by workbench session and expire with their session", async () => {
  const {f, stores} = fixture();
  f.start(); await flushStartup();
  const contract = f.requireSdk("@lodestory/sdk/asset-catalog");
  const service = f.getService(contract.assetCatalogKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);

  const first = await openReadyProject(workbench, project);
  const firstSessionId = first.session.id;
  const expired = service.getCatalog(firstSessionId);
  assert.ok(expired);
  assert.equal(await workbench.closeProject(), true);
  assert.equal(service.getCatalog(firstSessionId), null);
  assert.equal(expired.getSnapshot().blocked, true, "an expired handle reports its terminal state");
  assert.equal(stores[0].listeners.size, 0, "session disposal releases the catalog's store subscription");
  assert.equal(await expired.retry(), false, "an expired handle cannot retry its disposed store");
  assert.equal(stores[0].retryCalls, 0);

  const second = await openReadyProject(workbench, {...project, id: "catalog-book-two", path: "/projects/catalog-book-two"});
  const secondSessionId = second.session.id;
  const current = service.getCatalog(secondSessionId);
  assert.ok(current);
  assert.notEqual(secondSessionId, firstSessionId);
  assert.notStrictEqual(current, expired, "reopening creates a new session catalog");
  assert.deepEqual(JSON.parse(JSON.stringify(current.getSnapshot().types)), [], "catalog data does not leak between projects");
  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});
