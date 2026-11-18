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
    {id: assetId, name: "林舟", description: "主角", typeId, values: {memo: "旧船员", rank: "a", skills: ["b", "a"], peer: unclassifiedAssetId, score: 0}},
    {id: unclassifiedAssetId, name: "旧物件", description: "未分类", typeId: null, values: {}},
  ];
  const options = [{id: "a", title: "追踪"}, {id: "b", title: "航海"}];
  const templateField = (id, title, order, valueType = "text", config = {}, status = "active") => ({
    id, title, order, valueType, config, status, owner: {kind: "type", id: typeId},
  });
  stores[0].snapshot.fields = [
    templateField("peer", "随身物品", 4, "reference"),
    templateField("missing", "籍贯", 3),
    templateField("skills", "惯用技能", 1, "multiSelect", {options}),
    templateField("rank", "首选技能", 0, "singleSelect", {options}),
    templateField("score", "年限", 2, "number"),
    templateField("retired", "已归档字段", 5, "text", {}, "archived"),
    {id: "memo", title: "备注", order: 0, status: "active", valueType: "text", config: {}, owner: {kind: "asset", id: assetId}},
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
  assert.equal(Object.hasOwn(first.assets[0], "values"), false, "the metadata snapshot does not contain raw field values");
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.types) && Object.isFrozen(first.types[0]));
  assert.ok(Object.isFrozen(first.assets) && Object.isFrozen(first.assets[0]));
  assert.strictEqual(catalog.getSnapshot(), first, "unchanged reads return a stable snapshot reference");

  let notifications = 0;
  let detailNotifications = 0;
  const unsubscribe = catalog.subscribe(() => { notifications++; });
  const unsubscribeDetails = catalog.details.subscribe(() => { detailNotifications++; });
  const details = catalog.details.getSnapshot(assetId);
  assert.strictEqual(catalog.details.getSnapshot(assetId), details);
  assert.equal(catalog.details.getSnapshot("missing-asset"), null);
  assert.ok(Object.isFrozen(details) && Object.isFrozen(details.templateFields) && Object.isFrozen(details.templateFields[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(details)), {
    templateFields: [
      {id: "rank", label: "首选技能", value: "追踪"},
      {id: "skills", label: "惯用技能", value: "航海、追踪"},
      {id: "score", label: "年限", value: "0"},
      {id: "missing", label: "籍贯", value: "未填写"},
      {id: "peer", label: "随身物品", value: "旧物件"},
    ],
    customFields: [{id: "memo", label: "备注", value: "旧船员"}],
  });
  stores[0].snapshot.assets = stores[0].snapshot.assets.map(asset => asset.id === assetId
    ? {...asset, values: {...asset.values, memo: "现任船长"}} : asset);
  stores[0].store.publish();
  assert.strictEqual(catalog.getSnapshot(), first, "private property edits leave the public metadata snapshot stable");
  assert.equal(notifications, 0, "private property edits do not notify catalog consumers");
  assert.equal(detailNotifications, 1);
  assert.equal(catalog.details.getSnapshot(assetId).customFields[0].value, "现任船长");
  stores[0].snapshot.fields = stores[0].snapshot.fields.map(field => field.id === "memo" ? {...field, title: "船上身份"} : field);
  stores[0].store.publish();
  assert.equal(notifications, 0);
  assert.equal(detailNotifications, 2);
  assert.equal(catalog.details.getSnapshot(assetId).customFields[0].label, "船上身份");
  stores[0].snapshot.types = [{...stores[0].snapshot.types[0], name: "人物角色"}];
  stores[0].store.publish();
  const renamed = catalog.getSnapshot();
  assert.notStrictEqual(renamed, first);
  assert.equal(renamed.types[0].name, "人物角色");
  assert.equal(notifications, 1, "a relevant schema rename notifies catalog consumers");
  unsubscribe();
  unsubscribeDetails();
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
  const assetId = "40000000-0000-4000-8000-000000000006";
  stores[0].snapshot.assets = [{id: assetId, name: "旧物件", typeId: null, description: "", values: {}}];
  stores[0].store.publish();
  assert.ok(expired.details.getSnapshot(assetId));
  assert.equal(await workbench.closeProject(), true);
  assert.equal(service.getCatalog(firstSessionId), null);
  assert.equal(expired.details.getSnapshot(assetId), null);
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
