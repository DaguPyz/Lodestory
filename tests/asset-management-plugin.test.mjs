import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";
import {uiPluginFixture} from "./helpers/uiPluginFixture.mjs";

function fixture() {
  const stores = [];
  const controls = {load: "success", retry: true, save: true};
  function createAssetSchemaStore(files) {
    const snapshot = {
      types: [], assets: [], fields: [], selectedTypeId: null, selectedAssetId: null, loaded: false, loading: true, saving: false,
      dirty: false, blocked: false, error: null, saveState: "saved",
    };
    const record = {files, snapshot, retryCalls: 0, createAssetCalls: [], updateAssetCalls: [], disposed: false};
    async function persistMutation() {
      snapshot.dirty = !controls.save;
      snapshot.saving = false;
      snapshot.saveState = controls.save ? "saved" : "error";
      snapshot.error = controls.save ? null : "资产数据保存失败";
      return controls.save;
    }
    const store = {
      getSnapshot() { return snapshot; },
      subscribe() { return () => {}; },
      async load() {
        if (controls.load === "throw") throw new Error("schema load rejected");
        snapshot.loading = false;
        if (controls.load === "fail") {
          snapshot.error = "schema cannot be read";
          return false;
        }
        snapshot.loaded = true;
        return true;
      },
      async retry() {
        record.retryCalls++;
        if (!controls.retry) return false;
        snapshot.dirty = false;
        snapshot.error = null;
        snapshot.saveState = "saved";
        return true;
      },
      selectAsset(id) {
        if (id !== null && !snapshot.assets.some(asset => asset.id === id)) return false;
        snapshot.selectedAssetId = id;
        return true;
      },
      async createAsset(input) {
        record.createAssetCalls.push(input);
        const asset = {...input, values: {...(input.values ?? {})}};
        snapshot.assets = [...snapshot.assets, asset];
        snapshot.selectedAssetId = asset.id;
        snapshot.dirty = true;
        return persistMutation();
      },
      async updateAsset(id, patch) {
        record.updateAssetCalls.push({id, patch});
        snapshot.assets = snapshot.assets.map(asset => asset.id === id ? {
          ...asset,
          ...patch,
          ...(patch.values ? {values: {...asset.values, ...patch.values}} : {}),
        } : asset);
        snapshot.dirty = true;
        return persistMutation();
      },
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
  return {f, stores, controls};
}

const project = {id: "book", name: "故事", path: "/projects/book"};

test("asset schema sessions own their stores, guard project leave, and release resources after the views stop", async () => {
  const {f, stores, controls} = fixture();
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const contextMenuKey = f.requireSdk("@lodestory/sdk/context-menu").contextMenuKey;
  const contextMenus = f.getService(contextMenuKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const main = layout.getSnapshot().contents.find(({id}) => id === "asset-management.types");
  const assets = layout.getSnapshot().contents.find(({id}) => id === "asset-management.assets");
  const plugin = f.loadModule("plugins/asset-management/assetManagementPlugin.tsx").createAssetManagementPlugin();
  assert.ok(plugin.requires.includes(f.requireSdk("@lodestory/sdk/layout").layoutKey));
  assert.ok(plugin.requires.includes(f.requireSdk("@lodestory/sdk/workbench").workbenchKey));
  assert.ok(plugin.requires.includes(f.requireSdk("@lodestory/sdk/project-storage").projectStorageKey));
  assert.ok(plugin.requires.includes(contextMenuKey), "asset management declares its context-menu service dependency");
  assert.deepEqual(Array.from(plugin.provides, key => key.id), ["app/asset-catalog"],
    "the plugin exposes only the public read-only catalog capability");
  assert.equal(navigation.order, 20);
  assert.equal(navigation.title, "资产管理");
  assert.equal(main.role, "main");
  assert.equal(main.order, 20);
  assert.equal(main.title, "模板设置");
  assert.equal(assets.role, "main");
  assert.equal(assets.order, 21);
  assert.equal(assets.title, "对象管理");
  assert.equal(typeof contextMenus.Region, "function");
  const initialNavigationProps = navigation.render({active: true}).props;
  assert.strictEqual(initialNavigationProps.contextMenus, contextMenus,
    "the navigation view receives the shared context-menu service through its declared capability");
  initialNavigationProps.onOpenTypes();
  assert.ok(layout.getSnapshot().shownIds.includes(main.id));
  initialNavigationProps.onOpenAssets();
  assert.ok(layout.getSnapshot().shownIds.includes(assets.id));
  const mainProps = main.render({active: true}).props;
  assert.strictEqual(mainProps.contextMenus, contextMenus,
    "the template editor receives the same context-menu service instance");
  assert.equal(typeof mainProps.onOpenAssets, "function", "template settings can return to the scoped object list");
  mainProps.onOpenAssets();
  assert.ok(layout.getSnapshot().shownIds.includes(assets.id));
  const assetsProps = assets.render({active: true}).props;
  assert.strictEqual(assetsProps.contextMenus, contextMenus,
    "the object editor receives the same context-menu service instance");

  assert.equal(await workbench.openProject(project), true);
  const session = workbench.getSnapshot().session;
  const navProps = navigation.render({active: true}).props;
  const resource = navProps.sessions.get(session.id);
  assert.ok(resource);
  assert.strictEqual(resource.store, stores[0].store);
  assert.equal(resource.store.getSnapshot().loaded, true);

  const form = Symbol("unfinished type form");
  resource.editing.add(form);
  assert.equal(await workbench.closeProject(), false, "an unfinished form prevents project leave");
  assert.strictEqual(workbench.getSnapshot().session, session);
  resource.editing.delete(form);

  resource.store.getSnapshot().dirty = true;
  controls.retry = false;
  assert.equal(await workbench.closeProject(), false, "a failed schema retry preserves the current session");
  assert.strictEqual(workbench.getSnapshot().session, session);
  assert.equal(resource.store.getSnapshot().dirty, true);
  assert.equal(stores[0].retryCalls, 1);

  controls.retry = true;
  assert.equal(await workbench.closeProject(), true);
  assert.equal(stores[0].retryCalls, 2);
  assert.equal(stores[0].disposed, true);
  assert.equal(navProps.sessions.has(session.id), false);

  controls.load = "fail";
  assert.equal(await workbench.openProject(project), true, "a recoverable schema read failure does not block opening the project");
  const nextSession = workbench.getSnapshot().session;
  const nextResource = navigation.render({active: true}).props.sessions.get(nextSession.id);
  assert.notStrictEqual(nextResource.store, resource.store, "a reopened project gets a fresh session store");
  assert.equal(nextResource.store.getSnapshot().error, "schema cannot be read");
  assert.equal(await workbench.closeProject(), true, "a clean load error does not trap the project session");
  assert.equal(stores[1].disposed, true);

  await f.createdCores.at(-1).unmountAll();
});

test("an unexpected schema load rejection disposes the partially started session", async () => {
  const {f, stores, controls} = fixture();
  controls.load = "throw";
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  await assert.rejects(workbench.openProject(project), /schema load rejected/);
  assert.equal(stores[0].disposed, true);
  assert.equal(sessions.size, 0, "failed start removes the resource from the session map");
  await f.createdCores.at(-1).unmountAll();
});

test("asset creation and value edits retain the session draft when saving fails", async () => {
  const {f, stores, controls} = fixture();
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  assert.equal(await workbench.openProject(project), true);
  const session = workbench.getSnapshot().session;
  const resource = sessions.get(session.id);
  const assetId = "50000000-0000-4000-8000-000000000001";
  const templateFieldId = "50000000-0000-4000-8000-000000000002";
  const customFieldId = "50000000-0000-4000-8000-000000000003";

  controls.save = false;
  assert.equal(await resource.store.createAsset({
    id: assetId, name: "青霜剑", description: "主角的佩剑", typeId: null, values: {},
  }), false);
  assert.equal(await resource.store.updateAsset(assetId, {
    values: {[templateFieldId]: "玄阶", [customFieldId]: "剑身有一道裂纹"},
  }), false);
  assert.equal(stores[0].createAssetCalls.length, 1);
  assert.equal(stores[0].updateAssetCalls.length, 1);
  assert.deepEqual(resource.store.getSnapshot().assets[0].values, {
    [templateFieldId]: "玄阶",
    [customFieldId]: "剑身有一道裂纹",
  });
  assert.equal(resource.store.getSnapshot().dirty, true);

  const editingForm = Symbol("asset property edit");
  resource.editing.add(editingForm);
  assert.equal(await workbench.closeProject(), false, "an open asset editor prevents project leave");
  assert.strictEqual(workbench.getSnapshot().session, session);
  resource.editing.delete(editingForm);

  controls.retry = false;
  assert.equal(await workbench.closeProject(), false, "a failed save retry preserves edited asset values");
  assert.strictEqual(workbench.getSnapshot().session, session);
  assert.deepEqual(resource.store.getSnapshot().assets[0].values, {
    [templateFieldId]: "玄阶",
    [customFieldId]: "剑身有一道裂纹",
  });
  assert.equal(resource.store.getSnapshot().dirty, true);
  assert.equal(stores[0].retryCalls, 1);

  controls.retry = true;
  assert.equal(await workbench.closeProject(), true);
  assert.equal(stores[0].retryCalls, 2);
  assert.equal(stores[0].disposed, true);
  assert.equal(sessions.has(session.id), false);
  await f.createdCores.at(-1).unmountAll();
});

function persistentFixture() {
  const controls = {failSchemaSave: false};
  const storageFixture = byteStorageFixture({onInvoke(command, args) {
    if (controls.failSchemaSave && command === "save_project_file" && args.path === ".lodestory/assets/schema.json") {
      throw new Error("模拟资产资料保存失败");
    }
  }});
  let appFixture;
  function createProjectStoragePlugin() {
    const {projectStorageKey} = appFixture.requireSdk("@lodestory/sdk/project-storage");
    const {workbenchKey} = appFixture.requireSdk("@lodestory/sdk/workbench");
    let unregister;
    return {
      id: "project-storage",
      requires: [workbenchKey],
      provides: [projectStorageKey],
      activate(context) {
        const workbench = context.get(workbenchKey);
        const filesBySession = new Map();
        context.provide(projectStorageKey, Object.freeze({
          getFiles(sessionId) { return filesBySession.get(sessionId)?.service ?? null; },
        }));
        unregister = workbench.registerParticipant({
          id: "project-storage",
          start(session) {
            const files = storageFixture.files(session.project.path);
            filesBySession.set(session.id, files);
            return {
              async beforeLeave() {
                try { return await files.beginLeave(); }
                finally { files.endLeave(); }
              },
              async dispose() {
                try { await files.dispose(); }
                finally { if (filesBySession.get(session.id) === files) filesBySession.delete(session.id); }
              },
            };
          },
        });
      },
      async deactivate() { await unregister?.(); },
    };
  }
  appFixture = createMainFixture({moduleMocks: {
    "plugins/project-storage/projectStoragePlugin.ts": {createProjectStoragePlugin},
  }});
  return {f: appFixture, storage: storageFixture, controls};
}

test("asset type and field definitions persist by stable IDs and stay isolated by project", async () => {
  const {f, storage} = persistentFixture();
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  const originalProject = {id: "book-one", name: "第一本", path: "/stories/first"};
  const otherProject = {id: "book-two", name: "第二本", path: "/stories/second"};
  const typeId = "40000000-0000-4000-8000-000000000001";
  const firstFieldId = "40000000-0000-4000-8000-000000000002";
  const secondFieldId = "40000000-0000-4000-8000-000000000003";
  const schemaPath = ".lodestory/assets/schema.json";

  assert.equal(await workbench.openProject(originalProject), true);
  const originalSessionId = workbench.getSnapshot().session.id;
  const originalStore = sessions.get(originalSessionId).store;
  assert.equal(originalStore.getSnapshot().loaded, true);
  assert.equal(await originalStore.createType({id: typeId, name: "功法", description: "修炼与施展的方法"}), true);
  assert.equal(await originalStore.createField({id: firstFieldId, owner: {kind: "type", id: typeId},
    title: "品阶", valueType: "text", config: {}}), true);
  assert.equal(await originalStore.createField({id: secondFieldId, owner: {kind: "type", id: typeId},
    title: "效果", valueType: "text", config: {}}), true);
  assert.equal(await originalStore.renameField(firstFieldId, "境界"), true);
  assert.equal(await originalStore.moveField(secondFieldId, -1), true);
  assert.deepEqual(Array.from(originalStore.getSnapshot().fields).sort((left, right) => left.order - right.order)
    .map(({id, title, order}) => [id, title, order]), [
    [secondFieldId, "效果", 0], [firstFieldId, "境界", 1],
  ]);
  const originalBytes = storage.disk.get(storage.key(originalProject.path, schemaPath));
  assert.ok(originalBytes, "the schema is written through the project's real ProjectFiles byte store");

  assert.equal(await workbench.closeProject(), true);
  assert.equal(sessions.has(originalSessionId), false);
  assert.equal(await workbench.openProject(otherProject), true);
  const otherSessionId = workbench.getSnapshot().session.id;
  const otherStore = sessions.get(otherSessionId).store;
  assert.notStrictEqual(otherStore, originalStore);
  assert.deepEqual(Array.from(otherStore.getSnapshot().types), [], "a different project starts with an empty schema");
  assert.deepEqual(Array.from(otherStore.getSnapshot().fields), []);
  assert.equal(storage.disk.has(storage.key(otherProject.path, schemaPath)), false);

  assert.equal(await workbench.closeProject(), true);
  assert.equal(await workbench.openProject(originalProject), true);
  const restoredSessionId = workbench.getSnapshot().session.id;
  const restoredStore = sessions.get(restoredSessionId).store;
  assert.notStrictEqual(restoredStore, originalStore, "reopening creates a new store for the new workbench session");
  assert.equal(restoredStore.getSnapshot().loaded, true);
  assert.deepEqual(Array.from(restoredStore.getSnapshot().types, ({id, name, order}) => [id, name, order]), [
    [typeId, "功法", 0],
  ]);
  assert.deepEqual(Array.from(restoredStore.getSnapshot().fields).sort((left, right) => left.order - right.order)
    .map(({id, title, order}) => [id, title, order]), [
    [secondFieldId, "效果", 0], [firstFieldId, "境界", 1],
  ], "field IDs, renamed titles, and order restore from project storage");

  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("asset deletion survives a failed leave retry and persists after reopening the project", async () => {
  const {f, storage, controls} = persistentFixture();
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  const target = {id: "delete-book", name: "待删除资产项目", path: "/stories/delete-book"};
  const typeId = "60000000-0000-4000-8000-000000000001";
  const templateFieldId = "60000000-0000-4000-8000-000000000002";
  const assetId = "60000000-0000-4000-8000-000000000003";
  const otherAssetId = "60000000-0000-4000-8000-000000000004";
  const customFieldId = "60000000-0000-4000-8000-000000000005";

  assert.equal(await workbench.openProject(target), true);
  const sessionId = workbench.getSnapshot().session.id;
  const store = sessions.get(sessionId).store;
  assert.equal(await store.createType({id: typeId, name: "人物", description: "故事中的人物"}), true);
  assert.equal(await store.createField({id: templateFieldId, owner: {kind: "type", id: typeId},
    title: "身份", valueType: "text", config: {}}), true);
  assert.equal(await store.createAsset({id: assetId, name: "林舟", description: "待删除", typeId,
    values: {[templateFieldId]: "旅人"}}), true);
  assert.equal(await store.createField({id: customFieldId, owner: {kind: "asset", id: assetId},
    title: "秘密", valueType: "text", config: {}, defaultValue: "持有旧地图"}), true);
  assert.equal(await store.createAsset({id: otherAssetId, name: "沈遥", description: "保留", typeId, values: {}}), true);
  assert.equal(store.getSnapshot().assets.length, 2);
  assert.ok(store.getSnapshot().fields.some(field => field.id === customFieldId));

  controls.failSchemaSave = true;
  assert.equal(await store.removeAsset(assetId), false, "a failed write retains the deletion as a dirty candidate");
  assert.deepEqual(Array.from(store.getSnapshot().assets, asset => asset.id), [otherAssetId]);
  assert.deepEqual(Array.from(store.getSnapshot().fields, field => field.id), [templateFieldId], "deleting the asset removes its own fields only");
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(await workbench.closeProject(), false, "a failed leave retry keeps the project session open");
  assert.strictEqual(workbench.getSnapshot().session.id, sessionId);
  assert.deepEqual(Array.from(store.getSnapshot().assets, asset => asset.id), [otherAssetId], "retry failure preserves the pending deletion");
  assert.equal(store.getSnapshot().dirty, true);

  controls.failSchemaSave = false;
  assert.equal(await workbench.closeProject(), true, "leave retries and persists the deletion");
  assert.equal(sessions.has(sessionId), false);
  assert.equal(await workbench.openProject(target), true);
  const reopenedId = workbench.getSnapshot().session.id;
  const reopenedStore = sessions.get(reopenedId).store;
  assert.deepEqual(Array.from(reopenedStore.getSnapshot().assets, asset => asset.id), [otherAssetId]);
  assert.deepEqual(Array.from(reopenedStore.getSnapshot().fields, field => field.id), [templateFieldId]);
  assert.equal(reopenedStore.getSnapshot().types[0].id, typeId, "the type template remains after asset deletion");

  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("type deletion survives a failed leave retry and reopens without removing unrelated schema or assets", async () => {
  const {f, storage, controls} = persistentFixture();
  f.start(); await flushStartup();

  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  const target = {id: "delete-type-book", name: "类型删除项目", path: "/stories/delete-type-book"};
  const removedTypeId = "70000000-0000-4000-8000-000000000001";
  const retainedTypeId = "70000000-0000-4000-8000-000000000002";
  const removedFieldId = "70000000-0000-4000-8000-000000000003";
  const retainedFieldId = "70000000-0000-4000-8000-000000000004";
  const assetId = "70000000-0000-4000-8000-000000000005";
  const assetFieldId = "70000000-0000-4000-8000-000000000006";
  const schemaPath = ".lodestory/assets/schema.json";

  assert.equal(await workbench.openProject(target), true);
  const sessionId = workbench.getSnapshot().session.id;
  const store = sessions.get(sessionId).store;
  assert.equal(await store.createType({id: removedTypeId, name: "待删除类型", description: "待移除"}), true);
  assert.equal(await store.createType({id: retainedTypeId, name: "物品", description: "保留"}), true);
  assert.equal(await store.createField({id: removedFieldId, owner: {kind: "type", id: removedTypeId},
    title: "待移除字段", valueType: "text", config: {}}), true);
  assert.equal(await store.createField({id: retainedFieldId, owner: {kind: "type", id: retainedTypeId},
    title: "材质", valueType: "text", config: {}}), true);
  assert.equal(await store.createAsset({id: assetId, name: "旧地图", description: "未分类资产", typeId: null, values: {}}), true);
  assert.equal(await store.createField({id: assetFieldId, owner: {kind: "asset", id: assetId},
    title: "来源", valueType: "text", config: {}, defaultValue: "古书"}), true);

  controls.failSchemaSave = true;
  assert.equal(await store.removeType(removedTypeId), false, "a failed write retains the type deletion candidate");
  assert.deepEqual(Array.from(store.getSnapshot().types, type => type.id), [retainedTypeId]);
  assert.deepEqual(Array.from(store.getSnapshot().fields, field => field.id).sort(), [retainedFieldId, assetFieldId].sort(),
    "deleting a type removes its fields while preserving asset-owned fields");
  assert.deepEqual(Array.from(store.getSnapshot().assets, asset => asset.id), [assetId]);
  assert.equal(store.getSnapshot().dirty, true);
  const diskBeforeRetry = JSON.parse(new TextDecoder().decode(new Uint8Array(storage.disk.get(storage.key(target.path, schemaPath)))));
  assert.ok(diskBeforeRetry.types.some(type => type.id === removedTypeId), "failed save leaves the previous project file intact");

  assert.equal(await workbench.closeProject(), false, "a failed leave retry keeps the type-deletion session open");
  assert.strictEqual(workbench.getSnapshot().session.id, sessionId);
  assert.deepEqual(Array.from(store.getSnapshot().types, type => type.id), [retainedTypeId]);
  assert.equal(store.getSnapshot().dirty, true);
  controls.failSchemaSave = false;
  assert.equal(await workbench.closeProject(), true, "leave retries and persists the type deletion");

  assert.equal(await workbench.openProject(target), true);
  const reopenedStore = sessions.get(workbench.getSnapshot().session.id).store;
  assert.deepEqual(Array.from(reopenedStore.getSnapshot().types, type => type.id), [retainedTypeId]);
  assert.deepEqual(Array.from(reopenedStore.getSnapshot().fields, field => field.id).sort(), [retainedFieldId, assetFieldId].sort());
  assert.deepEqual(Array.from(reopenedStore.getSnapshot().assets, asset => asset.id), [assetId]);
  assert.equal(reopenedStore.getSnapshot().assets[0].values[assetFieldId], "古书");

  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("template scopes preserve per-type object values and an explicit unclassified scope through writes", async () => {
  const {f, storage} = persistentFixture();
  const target = {id: "template-scope-book", name: "模板范围项目", path: "/stories/template-scope"};
  const typeOneId = "80000000-0000-4000-8000-000000000001";
  const typeTwoId = "80000000-0000-4000-8000-000000000002";
  const fieldOneId = "80000000-0000-4000-8000-000000000003";
  const fieldTwoId = "80000000-0000-4000-8000-000000000004";
  const objectOneId = "80000000-0000-4000-8000-000000000005";
  const objectTwoId = "80000000-0000-4000-8000-000000000006";
  const legacyObjectId = "80000000-0000-4000-8000-000000000007";
  const legacyFieldId = "80000000-0000-4000-8000-000000000008";
  const schemaPath = ".lodestory/assets/schema.json";
  const initialSchema = {
    format: "lodestory.asset-schema", schemaVersion: 2,
    types: [
      {id: typeOneId, name: "人物", description: "角色", order: 0, status: "active"},
      {id: typeTwoId, name: "地点", description: "场景", order: 1, status: "active"},
    ],
    assets: [
      {id: objectOneId, name: "林舟", description: "人物记录", typeId: typeOneId, values: {[fieldOneId]: "旅人"}},
      {id: objectTwoId, name: "霜城", description: "地点记录", typeId: typeTwoId, values: {[fieldTwoId]: "北境"}},
      {id: legacyObjectId, name: "旧稿中的名字", description: "未分类的旧记录", typeId: null, values: {[legacyFieldId]: "沿用旧稿"}},
    ],
    fields: [
      {id: fieldOneId, owner: {kind: "type", id: typeOneId}, title: "身份", valueType: "text", config: {}, order: 0, status: "active"},
      {id: fieldTwoId, owner: {kind: "type", id: typeTwoId}, title: "方位", valueType: "text", config: {}, order: 0, status: "active"},
      {id: legacyFieldId, owner: {kind: "asset", id: legacyObjectId}, title: "旧记载", valueType: "text", config: {}, order: 0, status: "active"},
    ],
  };
  const schemaKey = storage.key(target.path, schemaPath);
  storage.disk.set(schemaKey, Array.from(new TextEncoder().encode(JSON.stringify(initialSchema))));
  storage.directories.add(storage.key(target.path, ".lodestory"));
  storage.directories.add(storage.key(target.path, ".lodestory/assets"));

  f.start(); await flushStartup();
  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const navigation = layout.getSnapshot().contents.find(({id}) => id === "asset-management.navigation");
  const sessions = navigation.render({active: true}).props.sessions;
  assert.equal(await workbench.openProject(target), true);
  const store = sessions.get(workbench.getSnapshot().session.id).store;
  assert.deepEqual(Array.from(store.getSnapshot().assets, asset => [asset.id, asset.typeId, asset.values[asset.typeId === typeOneId ? fieldOneId : fieldTwoId]]), [
    [objectOneId, typeOneId, "旅人"], [objectTwoId, typeTwoId, "北境"], [legacyObjectId, null, undefined],
  ]);

  assert.equal(store.selectType(typeTwoId), true);
  assert.equal(store.selectAsset(null), true, "selecting a template scope clears the previous object selection");
  assert.equal(store.getSnapshot().selectedAssetId, null);
  assert.equal(await store.updateAsset(objectTwoId, {values: {[fieldTwoId]: "北境·旧城区"}}), true);
  assert.equal(store.getSnapshot().selectedTypeId, typeTwoId);
  assert.equal(store.getSnapshot().selectedAssetId, null, "writes do not restore a stale selected object");
  assert.equal(store.getSnapshot().assets.find(asset => asset.id === objectOneId).values[fieldOneId], "旅人");

  assert.equal(store.selectType(null), true, "the unclassified object bucket is an explicit null template scope");
  assert.equal(store.selectAsset(null), true);
  assert.equal(await store.updateAsset(legacyObjectId, {values: {[legacyFieldId]: "沿用旧稿·已校订"}}), true);
  assert.equal(store.getSnapshot().selectedTypeId, null, "a successful write keeps the explicit unclassified scope null");
  assert.equal(store.getSnapshot().selectedAssetId, null);
  assert.equal(store.getSnapshot().assets.find(asset => asset.id === legacyObjectId).typeId, null);

  const savedSchema = JSON.parse(new TextDecoder().decode(new Uint8Array(storage.disk.get(schemaKey))));
  assert.deepEqual(savedSchema.assets.map(asset => [asset.id, asset.typeId, asset.values]), [
    [objectOneId, typeOneId, {[fieldOneId]: "旅人"}],
    [objectTwoId, typeTwoId, {[fieldTwoId]: "北境·旧城区"}],
    [legacyObjectId, null, {[legacyFieldId]: "沿用旧稿·已校订"}],
  ]);

  assert.equal(await workbench.closeProject(), true);
  assert.equal(await workbench.openProject(target), true);
  const reopened = sessions.get(workbench.getSnapshot().session.id).store;
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === objectOneId).values[fieldOneId], "旅人");
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === objectTwoId).values[fieldTwoId], "北境·旧城区");
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === legacyObjectId).typeId, null);
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === legacyObjectId).values[legacyFieldId], "沿用旧稿·已校订");

  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

function findReactElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReactElement(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return findReactElement(node.props?.children, predicate);
}

test("object view and search stay local while filtering both list modes", () => {
  const f = uiPluginFixture();
  // This fixture drives hook state directly; effects only manage focus and cleanup.
  f.React.useLayoutEffect = () => {};
  const {AssetRecordsEditor} = f.loadSource("plugins/asset-management/AssetRecordsView.tsx");
  const typeOne = {id: "view-type-one", name: "人物", description: "", order: 0, status: "active"};
  const typeTwo = {id: "view-type-two", name: "物品", description: "", order: 1, status: "active"};
  const nameField = {id: "view-name", owner: {kind: "type", id: typeOne.id}, title: "名称",
    valueType: "text", config: {}, order: 0, status: "active"};
  const abilityField = {id: "view-ability", owner: {kind: "type", id: typeOne.id}, title: "能力",
    valueType: "text", config: {}, order: 1, status: "active"};
  const unfilledField = {...abilityField, id: "view-unfilled", title: "未填写的模板字段", order: 2};
  const archivedField = {...abilityField, id: "view-archived", title: "已归档字段", order: 3, status: "archived"};
  const person = {id: "view-person", name: "林舟", description: "旅人", typeId: typeOne.id, color: "#d8e5f2",
    values: {[nameField.id]: "林舟", [abilityField.id]: "御风", [archivedField.id]: "旧记录"}};
  const customField = {...abilityField, id: "view-custom", title: "未填写的专属字段",
    owner: {kind: "asset", id: person.id}, order: 0};
  const archivedCustomField = {...customField, id: "view-custom-archived", order: 1, status: "archived"};
  const alchemist = {id: "view-alchemist", name: "青檀", description: "炼药师", typeId: typeOne.id,
    values: {[nameField.id]: "青檀", [abilityField.id]: "青莲地心火"}};
  const item = {id: "view-item", name: "青霜剑", description: "古剑", typeId: typeTwo.id, values: {}};
  const writes = [];

  function createResource(selectedTypeId) {
    const snapshot = {
      types: [typeOne, typeTwo], assets: [person, alchemist, item],
      fields: [nameField, abilityField, unfilledField, archivedField, customField, archivedCustomField],
      selectedTypeId, selectedAssetId: null, loaded: true, loading: false, saving: false,
      dirty: false, blocked: false, error: null, saveState: "saved",
    };
    const store = {
      getSnapshot() { return snapshot; },
      subscribe() { return () => {}; },
      selectType(id) { snapshot.selectedTypeId = id; return true; },
      selectAsset(id) {
        if (id !== null && !snapshot.assets.some(asset => asset.id === id)) return false;
        snapshot.selectedAssetId = id;
        return true;
      },
      createAsset(...args) { writes.push(["createAsset", ...args]); },
      updateAsset(...args) { writes.push(["updateAsset", ...args]); },
    };
    return {store, editing: new Set()};
  }

  let currentSession = {id: "view-session-one"};
  const workbenchSnapshot = {session: currentSession, active: true, busy: false};
  const workbench = {getSnapshot() { return workbenchSnapshot; }, subscribe() { return () => {}; }};
  const resources = new Map([[currentSession.id, createResource(typeOne.id)]]);
  const props = {
    workbench, sessions: resources, active: true, onOpenTypes() {},
    contextMenus: {Region: function Region() {}},
  };
  const editorHooks = {};
  const recordHooks = new Map();
  function render() {
    const editor = f.withHooks(editorHooks, () => AssetRecordsEditor(props));
    let hooks = recordHooks.get(editor.key);
    if (!hooks) recordHooks.set(editor.key, hooks = {});
    return f.withHooks(hooks, () => editor.type(editor.props));
  }
  function modeButton(tree, label) {
    return findReactElement(tree, element =>
      (element.type?.name === "Button" && element.props["aria-label"] === label)
      || (element.type?.name === "IconButton" && element.props.label === label));
  }
  function objectButton(tree, name) {
    return findReactElement(tree, element => element.type?.name === "Button" && element.props.title === name);
  }
  function searchField(tree) {
    return findReactElement(tree, element => element.type?.name === "SearchField" && element.props.label === "搜索对象");
  }
  function card(tree, name) {
    return findReactElement(tree, element => element.type === "li"
      && element.props.className === "asset-object-card" && objectButton(element, name));
  }
  function badgeLabel(card, scope) {
    return findReactElement(card, element => element.props["data-field-scope"] === scope)?.props["aria-label"];
  }
  const store = resources.get(currentSession.id).store;

  let tree = render();
  assert.equal(modeButton(tree, "列表视图")?.props["aria-pressed"], true, "a new project session starts in list mode");
  assert.ok(findReactElement(tree, element => element.type === "table" && element.props.className === "asset-object-table"));

  modeButton(tree, "卡片视图").props.onClick();
  tree = render();
  assert.equal(modeButton(tree, "卡片视图")?.props["aria-pressed"], true);
  assert.ok(findReactElement(tree, element => element.type === "ul" && element.props.className === "asset-object-cards"));
  assert.equal(card(tree, person.name).props.style["--asset-card-background"], person.color,
    "the saved object color is rendered as the exact card background");
  assert.equal(card(tree, person.name).props["data-colored"], true);
  assert.equal(card(tree, alchemist.name).props.style, undefined,
    "objects without a color keep the theme's default card surface");
  assert.equal(badgeLabel(card(tree, person.name), "template"), "模板字段 3 个",
    "template counts include unfilled active definitions and exclude archived fields even with retained values");
  assert.equal(badgeLabel(card(tree, person.name), "custom"), "专属字段 1 个",
    "custom counts use only the object's active definitions, including unfilled fields");
  assert.equal(badgeLabel(card(tree, alchemist.name), "custom"), "专属字段 0 个",
    "zero counts remain visible and do not include another object's fields");
  assert.ok(findReactElement(card(tree, person.name), element => element.type === "p" && element.props.children === person.description));
  assert.equal(findReactElement(tree, element => element.type === "dl"), undefined,
    "cards show field counts instead of expanding field values");
  assert.equal(searchField(tree)?.props.value, "");

  searchField(tree).props.onChange({currentTarget: {value: "青莲"}});
  tree = render();
  assert.equal(searchField(tree)?.props.value, "青莲");
  assert.equal(objectButton(tree, person.name), undefined, "search hides objects that do not match");
  assert.ok(objectButton(tree, alchemist.name), "search includes displayed field values");
  assert.equal(findReactElement(tree, element => element.type === "p" && element.props["aria-live"] === "polite")?.props.children,
    "1 / 2 个对象", "search reports matching and total object counts without repeating the badges");

  modeButton(tree, "列表视图").props.onClick();
  tree = render();
  assert.equal(searchField(tree)?.props.value, "青莲", "changing view preserves the local search query");
  assert.ok(findReactElement(tree, element => element.type === "table" && element.props.className === "asset-object-table"));
  assert.equal(objectButton(tree, person.name), undefined);
  assert.ok(objectButton(tree, alchemist.name), "list and card views share the same filtered objects");
  assert.ok(findReactElement(tree, element => element.type === "th" && element.props.children === nameField.title),
    "list view retains all active template field columns, including a field named 名称");
  assert.ok(findReactElement(tree, element => element.type === "span"
    && element.props.className === "asset-object-cell-value" && element.props.children === alchemist.name),
    "list view retains field values even when they repeat the object title");

  searchField(tree).props.onChange({currentTarget: {value: ""}});
  modeButton(render(), "卡片视图").props.onClick();
  tree = render();
  assert.ok(objectButton(tree, person.name));
  assert.ok(objectButton(tree, alchemist.name));
  objectButton(tree, person.name).props.onClick();
  tree = render();
  assert.ok(findReactElement(tree, element => element.type === "dt" && element.props.children === nameField.title));
  assert.ok(findReactElement(tree, element => element.type === "dd"
    && findReactElement(element, child => child.type === "span" && child.props.children === person.name)),
    "opening the card still exposes all field values in detail");
  assert.ok(findReactElement(tree, element => element.type?.name === "Button"
    && element.props["aria-label"] === `修改“${customField.title}”的属性标题`),
    "the counted unfilled custom field is available in detail");
  store.selectAsset(null);

  store.selectType(typeTwo.id);
  store.selectAsset(null);
  tree = render();
  assert.equal(modeButton(tree, "卡片视图")?.props["aria-pressed"], true, "changing template scope preserves the view mode");
  assert.ok(findReactElement(tree, element => element.type?.name === "Button" && element.props.title === item.name),
    "the card list renders objects from the newly selected template");
  assert.equal(badgeLabel(card(tree, item.name), "template"), "模板字段 0 个");
  assert.equal(badgeLabel(card(tree, item.name), "custom"), "专属字段 0 个");

  store.selectAsset(item.id);
  tree = render();
  assert.equal(modeButton(tree, "卡片视图"), undefined, "view controls are hidden while an object detail is open");
  store.selectAsset(null);
  tree = render();
  assert.equal(modeButton(tree, "卡片视图")?.props["aria-pressed"], true, "returning from object detail preserves the view mode");

  currentSession = {id: "view-session-two"};
  workbenchSnapshot.session = currentSession;
  resources.set(currentSession.id, createResource(typeOne.id));
  tree = render();
  assert.equal(modeButton(tree, "列表视图")?.props["aria-pressed"], true, "a new workbench session resets to list mode");
  assert.equal(modeButton(tree, "卡片视图")?.props["aria-pressed"], false);
  assert.deepEqual(writes, [], "view preference changes do not write asset schema data");
});
