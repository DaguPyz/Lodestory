import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";
import {deferred} from "./helpers/mainStartupFixture.mjs";

const source = await readFile(new URL("../src/plugins/asset-management/assetSchemaStore.ts", import.meta.url), "utf8");
const templateSource = await readFile(new URL("../src/plugins/asset-management/assetTemplateStore.ts", import.meta.url), "utf8");
const objectFilesSource = await readFile(new URL("../src/plugins/asset-management/assetObjectFiles.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const compiledTemplates = ts.transpileModule(templateSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const storeExports = {};
const templateExports = {};
const objectFilesExports = {};
const parseStats = {decodes: 0};
const validationWatch = {objects: new WeakSet(), rejectEntries: false};
const instrumentedObject = new Proxy(Object, {
  get(target, property, receiver) {
    if (property === "entries") return value => {
      if (validationWatch.rejectEntries && validationWatch.objects.has(value)) {
        throw new Error("排序不应枚举既有资产属性");
      }
      return Object.entries(value);
    };
    return Reflect.get(target, property, receiver);
  },
});
class CountingTextDecoder extends TextDecoder {
  decode(...args) {
    parseStats.decodes++;
    return super.decode(...args);
  }
}
const vmGlobals = {
  TextDecoder: CountingTextDecoder, TextEncoder, Uint8Array, Object: instrumentedObject, Array, Number, String,
  Set, Map, Promise, Error, RegExp, JSON, Math,
};
vm.runInNewContext(compiledTemplates, {...vmGlobals, TextDecoder, exports: templateExports});
const compiledObjectFiles = ts.transpileModule(objectFilesSource, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
vm.runInNewContext(compiledObjectFiles, {...vmGlobals, exports: objectFilesExports});
vm.runInNewContext(compiled, {...vmGlobals, exports: storeExports, require(specifier) {
  if (specifier === "./assetTemplateStore") return templateExports;
  if (specifier === "./assetObjectFiles") return objectFilesExports;
  throw new Error(`Unexpected asset schema dependency ${specifier}`);
}});
const {createAssetSchemaStore} = storeExports;

const typeId = "10000000-0000-4000-8000-000000000001";
const secondTypeId = "10000000-0000-4000-8000-000000000002";
const fieldId = "20000000-0000-4000-8000-000000000001";
const secondFieldId = "20000000-0000-4000-8000-000000000002";
const optionId = "30000000-0000-4000-8000-000000000001";
const path = ".lodestory/assets/schema.json";
const templatesPath = ".lodestory/assets/templates.json";
const legacyOrderPath = ".lodestory/assets/type-order.json";
const directory = ".lodestory/assets";

function storeFor(files) { return createAssetSchemaStore(files); }

function seedFile(f, targetPath, content) {
  f.disk.set(f.key("/book", targetPath), Array.from(typeof content === "string" ? new TextEncoder().encode(content) : content));
  const parts = targetPath.split("/");
  for (let index = 1; index < parts.length; index++) f.directories.add(f.key("/book", parts.slice(0, index).join("/")));
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function type(id = typeId, patch = {}) {
  return {id, name: "功法", description: "修炼方法", order: 0, status: "active", ...patch};
}

function textField(id = fieldId, patch = {}) {
  return {id, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}, order: 0, status: "active", ...patch};
}

function storedSchema(types = [], fields = [], patch = {}) {
  return {format: "lodestory.asset-schema", schemaVersion: 2, types, assets: [], fields, ...patch};
}

function currentSchema(assets = [], fields = []) {
  return {format: "lodestory.asset-schema", schemaVersion: 3, assets, fields};
}

function manifestSchema(groups = []) {
  return {format: "lodestory.asset-schema", schemaVersion: 4, groups};
}

function groupPath(id) {
  return `.lodestory/assets/objects/${id === null ? "unclassified" : id}.json`;
}

function seedGroup(f, id, assets = [], fields = []) {
  seedFile(f, groupPath(id), JSON.stringify({assets, fields}));
}

function groupDiskData(f, id) {
  const bytes = f.disk.get(f.key("/book", groupPath(id)));
  return bytes ? JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) : null;
}

function legacySchema(types = [], fields = []) {
  return {format: "lodestory.asset-schema", schemaVersion: 1, types, fields};
}

function rawDiskSchema(f) {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path)))));
}

function diskTemplates(f) {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", templatesPath)))));
}

function diskSchema(f) {
  const legacy = f.disk.has(f.key("/book", path)) ? rawDiskSchema(f) : null;
  const templates = f.disk.has(f.key("/book", templatesPath)) ? diskTemplates(f) : legacy?.types ?? [];
  if (legacy && legacy.schemaVersion < 4) return {...legacy, types: templates};
  const groups = [...templates.map(template => template.id), null].map(id => groupDiskData(f, id)).filter(Boolean);
  return {types: templates, assets: groups.flatMap(group => group.assets), fields: groups.flatMap(group => group.fields)};
}

function legacyTypeOrder(typeIds) {
  return {format: "lodestory.asset-type-order", schemaVersion: 1, typeIds};
}

function projectFilesWithOverlay(base, overlay, targetPath = path) {
  return Object.freeze({
    ...base,
    getSnapshot() {
      const snapshot = base.getSnapshot();
      const patch = overlay();
      if (!patch) return snapshot;
      return Object.freeze({...snapshot, files: Object.freeze(snapshot.files.map(file => file.path === targetPath
        ? Object.freeze({...file, ...patch}) : file))});
    },
  });
}

test("background group encoding preserves a concurrent file edit", async () => {
  const started = deferred();
  const release = deferred();
  const f = byteStorageFixture();
  const assetId = "40000000-0000-4000-8000-000000000001";
  const asset = {id: assetId, name: "原名称", description: "", typeId, values: {}};
  seedFile(f, templatesPath, JSON.stringify([type()]));
  seedFile(f, path, JSON.stringify(manifestSchema([typeId])));
  seedGroup(f, typeId, [asset]);
  const controller = f.files();
  const store = createAssetSchemaStore(controller.service, async (id, data) => {
    started.resolve();
    await release.promise;
    return objectFilesExports.encodeAssetGroupFallback({id, data});
  });
  assert.equal(await store.load(), true);
  const pending = store.updateAsset(assetId, {name: "我的修改"});
  await started.promise;
  const external = {assets: [{...asset, name: "其他修改"}], fields: []};
  assert.equal(controller.service.write(groupPath(typeId), new TextEncoder().encode(JSON.stringify(external)), {preferByteView: true}), true);
  release.resolve();
  assert.equal(await pending, false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().assets[0].name, "我的修改");
  const file = controller.service.getSnapshot().files.find(item => item.path === groupPath(typeId));
  const bytes = new Uint8Array(file.byteView.byteLength);
  file.byteView.copyTo(bytes);
  assert.equal(JSON.parse(new TextDecoder().decode(bytes)).assets[0].name, "其他修改");
  await store.dispose();
  await controller.dispose();
});

test("failed background group encoding retains the draft for retry", async () => {
  const f = byteStorageFixture();
  const assetId = "40000000-0000-4000-8000-000000000001";
  seedFile(f, templatesPath, JSON.stringify([type()]));
  seedFile(f, path, JSON.stringify(manifestSchema([typeId])));
  seedGroup(f, typeId, [{id: assetId, name: "原名称", description: "", typeId, values: {}}]);
  const controller = f.files();
  let fail = true;
  const store = createAssetSchemaStore(controller.service, async (id, data) => {
    if (fail) throw new Error("后台任务失败");
    return objectFilesExports.encodeAssetGroupFallback({id, data});
  });
  assert.equal(await store.load(), true);
  assert.equal(await store.updateAsset(assetId, {name: "新名称"}), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(groupDiskData(f, typeId).assets[0].name, "原名称");
  fail = false;
  assert.equal(await store.retry(), true);
  assert.equal(groupDiskData(f, typeId).assets[0].name, "新名称");
  await store.dispose();
  await controller.dispose();
});

function forbidLegacyByteProjection(files) {
  return Object.freeze({...files,
    getSnapshot() {
      const snapshot = files.getSnapshot();
      return Object.freeze({...snapshot, files: Object.freeze(snapshot.files.map(file => new Proxy(file, {
        get(target, property, receiver) {
          if (property === "bytes") throw new Error("asset store must use ProjectByteView instead of materializing ProjectFile.bytes");
          return Reflect.get(target, property, receiver);
        },
      })))});
    },
  });
}

test("template colors persist, validate, and can be edited or cleared", async () => {
  const f = byteStorageFixture();
  const store = storeFor(f.files().service);
  assert.equal(await store.load(), true);
  assert.equal(await store.createType({id: typeId, name: "人物", description: "", color: "#Ab12Cd"}), true);
  assert.equal(diskTemplates(f)[0].color, "#ab12cd");
  assert.equal(await store.updateType(typeId, {description: "描述"}), true);
  assert.equal(store.getSnapshot().types[0].color, "#ab12cd");
  assert.equal(await store.updateType(typeId, {color: "invalid"}), false);
  assert.equal(diskTemplates(f)[0].color, "#ab12cd");
  const reopened = storeFor(f.files().service);
  assert.equal(await reopened.load(), true);
  assert.equal(reopened.getSnapshot().types[0].color, "#ab12cd");
  assert.equal(await store.updateType(typeId, {color: null}), true);
  assert.equal(Object.hasOwn(diskTemplates(f)[0], "color"), false);
  store.dispose();
  reopened.dispose();
});

test("invalid saved template color blocks writes without losing the file", async () => {
  const f = byteStorageFixture();
  const original = JSON.stringify(storedSchema([type(typeId, {color: "#bad"})]));
  seedFile(f, path, original);
  const store = storeFor(f.files().service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);
  assert.equal(await store.updateType(typeId, {name: "其他"}), false);
  assert.equal(new TextDecoder().decode(new Uint8Array(f.disk.get(f.key("/book", path)))), original);
  store.dispose();
});

test("missing schema loads empty without creating a file; type and field edits persist by stable IDs", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);

  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().types), []);
  assert.deepEqual(plain(store.getSnapshot().fields), []);
  assert.equal(store.getSnapshot().loaded, true);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.equal(f.calls.some(call => call.command === "create_project_file"), false);

  assert.equal(await store.createType({id: typeId, name: " 功法 ", description: "修炼方法"}), true);
  assert.equal(store.getSnapshot().selectedTypeId, typeId);
  assert.deepEqual(diskTemplates(f), [type()]);
  assert.equal(f.disk.has(f.key("/book", path)), false, "creating a template does not create the body schema");
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}, defaultValue: "黄阶"}), true);
  assert.equal(await store.createField({id: secondFieldId, owner: {kind: "type", id: typeId}, title: "效果", valueType: "singleSelect", config: {options: [{id: optionId, title: "御风"}]}, defaultValue: optionId}), true);
  assert.equal(await store.renameField(fieldId, "等级"), true);
  assert.equal(await store.moveField(fieldId, 1), true);
  assert.equal(await store.updateType(typeId, {name: "术法"}), true);

  const saved = diskSchema(f);
  assert.equal(saved.types[0].id, typeId);
  assert.equal(saved.types[0].name, "术法");
  assert.deepEqual(saved.fields.map(field => [field.id, field.title, field.order]), [
    [fieldId, "等级", 1], [secondFieldId, "效果", 0],
  ]);
  assert.equal(saved.fields[1].defaultValue, optionId);
  assert.equal(await store.createType({id: secondTypeId, name: "兵器", description: "法器和武器"}), true);
  assert.equal(await store.moveType(secondTypeId, -1), true);
  assert.deepEqual(diskTemplates(f).map(item => [item.id, item.order]), [[secondTypeId, 0], [typeId, 1]]);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.equal(store.selectType(secondTypeId), true);
  assert.equal(store.getSnapshot().selectedTypeId, secondTypeId);
  assert.equal(store.selectType("not-a-type"), false);

  store.dispose();
  await controller.dispose();
});

test("legacy v1/v2 schemas and type-order sidecars migrate to complete template records on first template edit", async () => {
  const legacy = legacySchema([
    type(typeId, {name: "功法", order: 0, description: "旧描述"}),
    type(secondTypeId, {name: "兵器", order: 1, description: "武器"}),
  ], [textField()]);
  const original = JSON.stringify(legacy);
  const f = byteStorageFixture();
  seedFile(f, path, original);
  seedFile(f, legacyOrderPath, JSON.stringify(legacyTypeOrder([secondTypeId, typeId])));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => [item.id, item.order])), [[secondTypeId, 0], [typeId, 1]],
    "the old ID-order sidecar remains readable while migrating");
  const originalSchemaBytes = [...f.disk.get(f.key("/book", path))];

  assert.equal(await store.updateType(typeId, {description: "新描述", color: "#Ab12Cd"}), true);
  assert.deepEqual(diskTemplates(f), [
    type(secondTypeId, {name: "兵器", description: "武器", order: 0}),
    type(typeId, {name: "功法", description: "新描述", color: "#ab12cd", order: 1}),
  ], "migration writes complete records, including names, descriptions, colors, status and order");
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalSchemaBytes,
    "a template edit does not rewrite the legacy schema snapshot");

  store.dispose();
  await controller.dispose();
  const reopenedController = f.files();
  const reopened = storeFor(reopenedController.service);
  assert.equal(await reopened.load(), true);
  assert.deepEqual(plain(reopened.getSnapshot().types), diskTemplates(f), "the new list is authoritative after reopening");
  reopened.dispose();
  await reopenedController.dispose();
});

test("existing templates.json overrides legacy schema types and is reused during body migration", async () => {
  const legacy = storedSchema([type(typeId, {name: "旧名称", description: "旧模板"})]);
  const templates = [type(typeId, {name: "新名称", description: "新模板"})];
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(legacy));
  seedFile(f, templatesPath, JSON.stringify(templates));
  seedFile(f, legacyOrderPath, JSON.stringify(legacyTypeOrder([secondTypeId])));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().types), templates, "the dedicated list wins over both legacy sources");
  const originalTemplateBytes = [...f.disk.get(f.key("/book", templatesPath))];

  assert.equal(await store.createAsset({id: "40000000-0000-4000-8000-000000000091", name: "新资产", description: "", typeId}), true);
  assert.equal(f.disk.has(f.key("/book", path)), false, "the old schema is retired");
  assert.deepEqual(groupDiskData(f, typeId).assets, [
    {id: "40000000-0000-4000-8000-000000000091", name: "新资产", description: "", typeId, values: {}},
  ]);
  assert.deepEqual(f.disk.get(f.key("/book", templatesPath)), originalTemplateBytes,
    "an existing authoritative list is not rewritten during body migration");
  store.dispose();
  await controller.dispose();
});

test("a body edit on a legacy project saves the template list and removes the old schema", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(storedSchema([type(), type(secondTypeId, {name: "兵器", order: 1})])));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.createAsset({id: "40000000-0000-4000-8000-000000000092", name: "青霜剑", description: "", typeId}), true);
  assert.deepEqual(diskTemplates(f), [type(), type(secondTypeId, {name: "兵器", order: 1})]);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  const createdCatalog = f.calls.findIndex(call => call.command === "create_project_file" && call.args.path === templatesPath);
  const deletedLegacy = f.calls.findIndex(call => call.command === "delete_project_file" && call.args.path === path);
  assert.ok(createdCatalog >= 0 && deletedLegacy > createdCatalog, "the catalog is persisted before removing the old file");

  store.dispose();
  await controller.dispose();
});

test("template create, rename, color and reorder persist only the complete templates list", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  assert.equal(await store.createType({id: secondTypeId, name: "兵器", description: "刀剑"}), true);
  assert.equal(await store.updateType(typeId, {name: "术法", description: "变化的法术", color: "#Ab12Cd"}), true);
  assert.equal(await store.moveType(secondTypeId, -1), true);

  assert.deepEqual(diskTemplates(f), [
    type(secondTypeId, {name: "兵器", description: "刀剑", order: 0}),
    type(typeId, {name: "术法", description: "变化的法术", color: "#ab12cd", order: 1}),
  ]);
  assert.equal(f.disk.has(f.key("/book", path)), false, "template-only changes do not create schema.json");
  assert.ok(f.calls.filter(call => ["create_project_file", "save_project_file"].includes(call.command))
    .every(call => call.args.path === templatesPath), "all template-only writes target templates.json");

  store.dispose();
  await controller.dispose();
  const reopenedController = f.files();
  const reopened = storeFor(reopenedController.service);
  assert.equal(await reopened.load(), true);
  assert.deepEqual(plain(reopened.getSnapshot().types), diskTemplates(f));
  reopened.dispose();
  await reopenedController.dispose();
});

test("template reordering leaves asset and field bytes untouched and never enumerates their values", async () => {
  const assetId = "60000000-0000-4000-8000-000000000091";
  const stored = storedSchema([
    type(typeId, {name: "功法", order: 0}),
    type(secondTypeId, {name: "兵器", order: 1}),
  ], [textField()], {assets: [{id: assetId, name: "青霜剑", description: "旧物", typeId,
    values: {[fieldId]: "玄铁"}}]});
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(stored));
  const originalSchemaBytes = [...f.disk.get(f.key("/book", path))];
  const controller = f.files();
  const store = storeFor(forbidLegacyByteProjection(controller.service));
  assert.equal(await store.load(), true);
  const assets = store.getSnapshot().assets;
  const fields = store.getSnapshot().fields;
  const values = assets[0].values;
  validationWatch.objects.add(values);

  validationWatch.rejectEntries = true;
  let reordered;
  try { reordered = await store.moveType(secondTypeId, -1); }
  finally { validationWatch.rejectEntries = false; }

  assert.equal(reordered, true);
  assert.strictEqual(store.getSnapshot().assets, assets);
  assert.strictEqual(store.getSnapshot().fields, fields);
  assert.strictEqual(store.getSnapshot().assets[0].values, values);
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalSchemaBytes,
    "a sort action leaves schema.json byte-for-byte unchanged");
  assert.deepEqual(diskTemplates(f), [type(secondTypeId, {name: "兵器", order: 0}), type(typeId, {order: 1})]);
  assert.ok(f.transports.some(({command}) => command === "read_project_file_base64"), "legacy files load through compact byte reads");

  store.dispose();
  await controller.dispose();
});

test("a failed first templates.json write stays dirty and can be retried", async () => {
  let failCreate = true;
  const f = byteStorageFixture({onInvoke(command, args) {
    if (failCreate && command === "create_project_file" && args.path === templatesPath) throw new Error("创建模板列表失败");
  }});
  seedFile(f, path, JSON.stringify(storedSchema([
    type(typeId, {name: "功法", order: 0}), type(secondTypeId, {name: "兵器", order: 1}),
  ])));
  const originalSchemaBytes = [...f.disk.get(f.key("/book", path))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.moveType(secondTypeId, -1), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => item.id)), [secondTypeId, typeId]);
  assert.equal(f.disk.has(f.key("/book", templatesPath)), false);
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalSchemaBytes);

  failCreate = false;
  assert.equal(await store.retry(), true);
  assert.deepEqual(diskTemplates(f), [type(secondTypeId, {name: "兵器", order: 0}), type(typeId, {order: 1})]);
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalSchemaBytes);
  store.dispose();
  await controller.dispose();
});

test("a first templates.json create that reached disk before its response failed is idempotently retried", async () => {
  let fixture;
  let failAfterDiskWrite = true;
  fixture = byteStorageFixture({onInvoke(command, args) {
    if (failAfterDiskWrite && command === "create_project_file" && args.path === templatesPath) {
      failAfterDiskWrite = false;
      seedFile(fixture, args.path, args.bytes);
      throw new Error("模板列表已写入，但确认响应失败");
    }
  }});
  const controller = fixture.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const input = {id: typeId, name: "功法", description: "修炼方法"};
  assert.equal(await store.createType(input), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(diskTemplates(fixture), [type()]);
  assert.equal(await store.createType(input), true, "same-ID retry accepts the identical list already present on disk");
  assert.deepEqual(diskTemplates(fixture), [type()]);
  assert.equal(fixture.calls.filter(call => call.command === "create_project_file" && call.args.path === templatesPath).length, 2);
  store.dispose();
  await controller.dispose();
});

test("successive moves during a pending list save accumulate and persist the latest order", async () => {
  const thirdTypeId = "10000000-0000-4000-8000-000000000003";
  const entered = deferred();
  const release = deferred();
  let pauseSave = true;
  const f = byteStorageFixture({async onInvoke(command, args) {
    if (command === "save_project_file" && args.path === templatesPath && pauseSave) {
      pauseSave = false;
      entered.resolve();
      await release.promise;
    }
  }});
  seedFile(f, templatesPath, JSON.stringify([
    type(typeId, {name: "功法", order: 0}),
    type(secondTypeId, {name: "兵器", order: 1}),
    type(thirdTypeId, {name: "丹药", order: 2}),
  ]));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const firstMove = store.moveType(thirdTypeId, -1);
  await entered.promise;
  const secondMove = store.moveType(thirdTypeId, -1);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => [item.id, item.order])), [
    [thirdTypeId, 0], [typeId, 1], [secondTypeId, 2],
  ]);
  release.resolve();
  assert.deepEqual(await Promise.all([firstMove, secondMove]), [true, true]);
  assert.deepEqual(diskTemplates(f), [
    type(thirdTypeId, {name: "丹药", order: 0}),
    type(typeId, {name: "功法", order: 1}),
    type(secondTypeId, {name: "兵器", order: 2}),
  ]);
  assert.equal(f.disk.has(f.key("/book", path)), false, "the save queue writes no asset body schema");
  store.dispose();
  await controller.dispose();
});

test("moves received during a failing list save remain dirty and retry writes their final order", async () => {
  const thirdTypeId = "10000000-0000-4000-8000-000000000004";
  const entered = deferred();
  const release = deferred();
  let pauseFirstSave = true;
  let failSaves = true;
  const f = byteStorageFixture({async onInvoke(command, args) {
    if (command !== "save_project_file" || args.path !== templatesPath) return;
    if (pauseFirstSave) {
      pauseFirstSave = false;
      entered.resolve();
      await release.promise;
    }
    if (failSaves) throw new Error("模板列表保存失败");
  }});
  seedFile(f, templatesPath, JSON.stringify([
    type(typeId, {name: "功法", order: 0}),
    type(secondTypeId, {name: "兵器", order: 1}),
    type(thirdTypeId, {name: "丹药", order: 2}),
  ]));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const firstMove = store.moveType(thirdTypeId, -1);
  await entered.promise;
  const secondMove = store.moveType(thirdTypeId, -1);
  release.resolve();
  assert.deepEqual(await Promise.all([firstMove, secondMove]), [false, false]);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => [item.id, item.order])), [
    [thirdTypeId, 0], [typeId, 1], [secondTypeId, 2],
  ]);

  failSaves = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().dirty, false);
  assert.deepEqual(diskTemplates(f), [
    type(thirdTypeId, {name: "丹药", order: 0}),
    type(typeId, {name: "功法", order: 1}),
    type(secondTypeId, {name: "兵器", order: 2}),
  ]);
  store.dispose();
  await controller.dispose();
});

test("successive moves during first templates.json creation persist the latest list", async () => {
  const thirdTypeId = "10000000-0000-4000-8000-000000000005";
  const entered = deferred();
  const release = deferred();
  let pauseCreate = true;
  const f = byteStorageFixture({async onInvoke(command, args) {
    if (command === "create_project_file" && args.path === templatesPath && pauseCreate) {
      pauseCreate = false;
      entered.resolve();
      await release.promise;
    }
  }});
  seedFile(f, path, JSON.stringify(storedSchema([
    type(typeId, {name: "功法", order: 0}),
    type(secondTypeId, {name: "兵器", order: 1}),
    type(thirdTypeId, {name: "丹药", order: 2}),
  ])));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const firstMove = store.moveType(thirdTypeId, -1);
  await entered.promise;
  const secondMove = store.moveType(thirdTypeId, -1);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => [item.id, item.order])), [
    [thirdTypeId, 0], [typeId, 1], [secondTypeId, 2],
  ]);
  release.resolve();
  assert.deepEqual(await Promise.all([firstMove, secondMove]), [true, true]);
  assert.deepEqual(diskTemplates(f), [
    type(thirdTypeId, {name: "丹药", order: 0}),
    type(typeId, {name: "功法", order: 1}),
    type(secondTypeId, {name: "兵器", order: 2}),
  ]);
  store.dispose();
  await controller.dispose();
});

test("corrupt templates.json is preserved and becomes writable after external repair", async () => {
  const f = byteStorageFixture();
  const corrupt = "{broken templates JSON";
  seedFile(f, templatesPath, corrupt);
  const originalBytes = [...f.disk.get(f.key("/book", templatesPath))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);
  assert.equal(await store.createType({id: typeId, name: "不写入", description: ""}), false);
  assert.deepEqual(f.disk.get(f.key("/book", templatesPath)), originalBytes, "loading never overwrites malformed source data");

  const repair = new TextEncoder().encode(JSON.stringify([type()]));
  assert.equal(controller.service.write(templatesPath, repair, {preferByteView: true}), true);
  assert.equal(await controller.service.save(templatesPath), true);
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().blocked, false);
  assert.deepEqual(plain(store.getSnapshot().types), [type()]);
  store.dispose();
  await controller.dispose();
});

test("v3 schema data without templates.json stays blocked and preserves its references", async () => {
  const assetId = "40000000-0000-4000-8000-000000000093";
  const legacyV3 = currentSchema([{id: assetId, name: "无模板资产", description: "引用缺失模板", typeId, values: {}}]);
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(legacyV3));
  const original = [...f.disk.get(f.key("/book", path))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);
  assert.deepEqual(f.disk.get(f.key("/book", path)), original);
  assert.equal(f.disk.has(f.key("/book", templatesPath)), false,
    "v3 never reconstructs the authoritative list from assets or stale data");
  assert.equal(f.calls.some(call => ["create_project_file", "save_project_file"].includes(call.command)), false);
  seedFile(f, templatesPath, JSON.stringify([type()]));
  assert.equal(await store.retry(), true, "retry discovers a restored catalog in the same session");
  assert.equal(store.getSnapshot().assets[0].typeId, typeId);
  store.dispose();
  await controller.dispose();
});

test("existing group files must belong to their template and have the expected fields", async t => {
  const assetId = "40000000-0000-4000-8000-000000000121";
  for (const [label, groupContent] of [
    ["wrong owner type", {assets: [{id: assetId, name: "错组对象", description: "", typeId: secondTypeId, values: {}}], fields: []}],
    ["unknown group fields", {assets: [], fields: [], legacy: true}],
  ]) {
    await t.test(label, async () => {
      const f = byteStorageFixture();
      seedFile(f, templatesPath, JSON.stringify([type()]));
      seedFile(f, groupPath(typeId), JSON.stringify(groupContent));
      const controller = f.files();
      const store = storeFor(controller.service);
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().blocked, true);
      assert.equal(await store.updateType(typeId, {name: "不应保存"}), false);
      assert.deepEqual(groupDiskData(f, typeId), groupContent);
      store.dispose();
      await controller.dispose();
    });
  }
});

test("a corrupt authoritative list never falls back to legacy schema types", async () => {
  const f = byteStorageFixture();
  const legacy = JSON.stringify(storedSchema([type(typeId, {name: "旧模板"})]));
  seedFile(f, path, legacy);
  seedFile(f, templatesPath, "{broken authoritative templates JSON");
  const originalSchemaBytes = [...f.disk.get(f.key("/book", path))];
  const originalTemplateBytes = [...f.disk.get(f.key("/book", templatesPath))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().blocked, true);
  assert.equal(await store.updateType(typeId, {name: "不应回退"}), false);
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalSchemaBytes);
  assert.deepEqual(f.disk.get(f.key("/book", templatesPath)), originalTemplateBytes);
  store.dispose();
  await controller.dispose();
});

test("an external template ID change that breaks asset references blocks further saves", async () => {
  const assetId = "40000000-0000-4000-8000-000000000094";
  const f = byteStorageFixture();
  seedFile(f, templatesPath, JSON.stringify([type()]));
  seedFile(f, path, JSON.stringify(currentSchema([
    {id: assetId, name: "关联资产", description: "依赖模板 ID", typeId, values: {}},
  ])));
  seedFile(f, templatesPath, JSON.stringify([type()]));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  const replacement = new TextEncoder().encode(JSON.stringify([type(secondTypeId, {name: "替换模板"})]));
  assert.equal(controller.service.write(templatesPath, replacement, {preferByteView: true}), true);
  assert.equal(await controller.service.save(templatesPath), true);
  assert.equal(store.getSnapshot().blocked, true);
  assert.match(store.getSnapshot().error, /ID 不匹配/);
  assert.equal(await store.updateAsset(assetId, {description: "不应保存"}), false);
  assert.equal(diskSchema(f).assets[0].description, "依赖模板 ID");

  store.dispose();
  await controller.dispose();
});

test("corrupt legacy type-order data blocks template writes but can be repaired", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(storedSchema([
    type(typeId, {name: "功法", order: 0}), type(secondTypeId, {name: "兵器", order: 1}),
  ])));
  seedFile(f, legacyOrderPath, "{broken order JSON");
  const originalBytes = [...f.disk.get(f.key("/book", legacyOrderPath))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true, "asset records remain readable even if a legacy ordering sidecar is corrupt");
  assert.equal(store.getSnapshot().orderBlocked, true);
  assert.equal(await store.moveType(secondTypeId, -1), false);
  assert.deepEqual(f.disk.get(f.key("/book", legacyOrderPath)), originalBytes);

  const repair = new TextEncoder().encode(JSON.stringify(legacyTypeOrder([secondTypeId, typeId])));
  assert.equal(controller.service.write(legacyOrderPath, repair, {preferByteView: true}), true);
  assert.equal(await controller.service.save(legacyOrderPath), true);
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().orderBlocked, false);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => item.id)), [secondTypeId, typeId]);
  store.dispose();
  await controller.dispose();
});

test("deleting a template with fields cleans the schema before removing its list record", async () => {
  const templateFieldId = "20000000-0000-4000-8000-000000000081";
  const f = byteStorageFixture();
  seedFile(f, templatesPath, JSON.stringify([type(), type(secondTypeId, {name: "兵器", order: 1})]));
  seedFile(f, path, JSON.stringify(currentSchema([], [textField(templateFieldId)])));
  seedFile(f, templatesPath, JSON.stringify([type(), type(secondTypeId, {name: "兵器", order: 1})]));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.removeType(typeId), true);
  assert.deepEqual(diskTemplates(f), [type(secondTypeId, {name: "兵器", order: 1})]);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.deepEqual(groupDiskData(f, typeId).fields, []);
  const writes = f.calls.filter(call => call.command === "save_project_file").map(call => call.args.path);
  assert.ok(writes.indexOf(groupPath(typeId)) >= 0 && writes.indexOf(templatesPath) > writes.indexOf(groupPath(typeId)),
    "owned template fields are removed before the template record is deleted");

  store.dispose();
  await controller.dispose();
  const reopenedController = f.files();
  const reopened = storeFor(reopenedController.service);
  assert.equal(await reopened.load(), true);
  assert.deepEqual(plain(reopened.getSnapshot().fields), []);
  assert.deepEqual(plain(reopened.getSnapshot().types), diskTemplates(f));
  reopened.dispose();
  await reopenedController.dispose();
});

test("type creation requests are transient and require a clean loaded store", async () => {
  const entered = deferred();
  const release = deferred();
  let pauseSave = false;
  let failSave = false;
  const f = byteStorageFixture({async onInvoke(command) {
    if (pauseSave && command === "save_project_file") {
      pauseSave = false;
      entered.resolve();
      await release.promise;
    }
    if (failSave && command === "save_project_file") throw new Error("保存暂不可用");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(store.requestTypeCreation(), false, "a store must finish loading first");
  assert.equal(store.getSnapshot().typeCreationRequest, 0);
  assert.equal(await store.load(), true);
  assert.equal(store.requestTypeCreation(), true);
  assert.equal(store.getSnapshot().typeCreationRequest, 1);
  assert.equal(f.calls.some(call => call.command === "create_project_file" || call.command === "save_project_file"), false,
    "requesting the form does not write the schema file");

  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  pauseSave = true;
  const saving = store.updateType(typeId, {description: "保存期间"});
  await entered.promise;
  assert.equal(store.getSnapshot().saving, true);
  assert.equal(store.requestTypeCreation(), false);
  assert.equal(store.getSnapshot().typeCreationRequest, 1);
  release.resolve();
  assert.equal(await saving, true);

  failSave = true;
  assert.equal(await store.updateType(typeId, {description: "脏草稿"}), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.requestTypeCreation(), false);
  assert.equal(store.getSnapshot().typeCreationRequest, 1);
  failSave = false;
  assert.equal(await store.retry(), true);
  store.dispose();
  assert.equal(store.requestTypeCreation(), false, "disposed stores cannot issue UI requests");
  await controller.dispose();

  const blockedFiles = byteStorageFixture();
  seedFile(blockedFiles, path, JSON.stringify(storedSchema([], [], {schemaVersion: 3})));
  const blockedController = blockedFiles.files();
  const blockedStore = storeFor(blockedController.service);
  assert.equal(await blockedStore.load(), false);
  assert.equal(blockedStore.requestTypeCreation(), false);
  assert.equal(blockedStore.getSnapshot().typeCreationRequest, 0);
  blockedStore.dispose();
  await blockedController.dispose();
});

test("explicit unclassified type selection survives writes and shared-file refreshes", async () => {
  let failSave = false;
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("保存暂不可用");
  }});
  const controller = f.files();
  const first = storeFor(controller.service);
  assert.equal(await first.load(), true);
  assert.equal(await first.createType({id: typeId, name: "甲类", description: "顺序 0"}), true);
  assert.equal(await first.createType({id: secondTypeId, name: "乙类", description: "顺序 1"}), true);
  assert.equal(first.getSnapshot().selectedTypeId, secondTypeId, "creating a type selects it");

  const second = storeFor(controller.service);
  assert.equal(await second.load(), true);
  assert.equal(second.getSnapshot().selectedTypeId, typeId, "a fresh store defaults to the lowest-order active type");
  assert.equal(first.selectType(null), true);
  assert.equal(first.getSnapshot().selectedTypeId, null);
  assert.equal(await second.updateType(secondTypeId, {description: "共享刷新"}), true);
  assert.equal(first.getSnapshot().selectedTypeId, null, "a shared-file refresh preserves explicit null");

  failSave = true;
  assert.equal(await first.updateType(typeId, {description: "失败后保留"}), false);
  assert.equal(first.getSnapshot().selectedTypeId, null);
  failSave = false;
  assert.equal(await first.retry(), true);
  assert.equal(first.getSnapshot().selectedTypeId, null, "save/retry preserves the explicit legacy view");
  assert.equal(await first.load(), true);
  assert.equal(first.getSnapshot().selectedTypeId, null, "load on the same store preserves explicit null");

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().selectedTypeId, typeId, "a new store chooses the default active type");
  first.dispose();
  second.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("explicit asset-list selection survives writes and shared refreshes without being serialized", async () => {
  let failSave = false;
  const firstAssetId = "40000000-0000-4000-8000-000000000031";
  const secondAssetId = "40000000-0000-4000-8000-000000000032";
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("保存暂不可用");
  }});
  const controller = f.files();
  const first = storeFor(controller.service);
  assert.equal(await first.load(), true);
  assert.equal(await first.createAsset({id: firstAssetId, name: "甲资产", description: "", typeId: null}), true);
  assert.equal(await first.createAsset({id: secondAssetId, name: "乙资产", description: "", typeId: null}), true);
  assert.equal(first.getSnapshot().selectedAssetId, secondAssetId, "creating an asset selects it");

  const second = storeFor(controller.service);
  assert.equal(await second.load(), true);
  assert.equal(second.getSnapshot().selectedAssetId, firstAssetId, "a fresh store defaults to the first asset");
  assert.equal(first.selectAsset(null), true);
  assert.equal(await second.updateAsset(firstAssetId, {description: "共享刷新"}), true);
  assert.equal(first.getSnapshot().selectedAssetId, null, "a shared-file refresh preserves explicit null");

  failSave = true;
  assert.equal(await first.updateAsset(secondAssetId, {description: "失败后仍在列表"}), false);
  assert.equal(first.getSnapshot().selectedAssetId, null);
  failSave = false;
  assert.equal(await first.retry(), true);
  assert.equal(first.getSnapshot().selectedAssetId, null, "save/retry preserves the list view");
  assert.equal(await first.load(), true);
  assert.equal(first.getSnapshot().selectedAssetId, null, "load on the same store preserves explicit null");
  assert.equal(Object.hasOwn(diskSchema(f), "selectedAssetId"), false, "selection state is transient");

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().selectedAssetId, firstAssetId, "a new store chooses the default asset");
  first.dispose();
  second.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("number, multi-select, and reference defaults and configuration survive reload", async () => {
  const numberFieldId = "20000000-0000-4000-8000-000000000003";
  const multiFieldId = "20000000-0000-4000-8000-000000000004";
  const referenceFieldId = "20000000-0000-4000-8000-000000000005";
  const firstOptionId = "30000000-0000-4000-8000-000000000002";
  const secondOptionId = "30000000-0000-4000-8000-000000000003";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  assert.equal(await store.createType({id: secondTypeId, name: "人物", description: "故事人物"}), true);
  assert.equal(await store.createField({
    id: numberFieldId, owner: {kind: "type", id: typeId}, title: "修炼年限", valueType: "number", config: {}, defaultValue: 0,
  }), true);
  assert.equal(await store.createField({
    id: multiFieldId,
    owner: {kind: "type", id: typeId},
    title: "适用流派",
    valueType: "multiSelect",
    config: {options: [{id: firstOptionId, title: "剑修"}, {id: secondOptionId, title: "符修"}]},
    defaultValue: [firstOptionId, secondOptionId],
  }), true);
  assert.equal(await store.createField({
    id: referenceFieldId,
    owner: {kind: "type", id: typeId},
    title: "创立者",
    valueType: "reference",
    config: {targetTypeId: secondTypeId},
  }), true);
  store.dispose();

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  const fields = plain(reloaded.getSnapshot().fields);
  assert.deepEqual(fields.find(field => field.id === numberFieldId), {
    id: numberFieldId,
    owner: {kind: "type", id: typeId},
    title: "修炼年限",
    valueType: "number",
    config: {},
    defaultValue: 0,
    order: 0,
    status: "active",
  });
  assert.deepEqual(fields.find(field => field.id === multiFieldId), {
    id: multiFieldId,
    owner: {kind: "type", id: typeId},
    title: "适用流派",
    valueType: "multiSelect",
    config: {options: [{id: firstOptionId, title: "剑修"}, {id: secondOptionId, title: "符修"}]},
    defaultValue: [firstOptionId, secondOptionId],
    order: 1,
    status: "active",
  });
  assert.deepEqual(fields.find(field => field.id === referenceFieldId), {
    id: referenceFieldId,
    owner: {kind: "type", id: typeId},
    title: "创立者",
    valueType: "reference",
    config: {targetTypeId: secondTypeId},
    order: 2,
    status: "active",
  });
  assert.equal(reloaded.getSnapshot().types.find(item => item.id === secondTypeId).name, "人物");
  reloaded.dispose();
  await controller.dispose();
});

test("assets receive template defaults only at creation and support asset-owned fields", async () => {
  const defaultTextId = "20000000-0000-4000-8000-000000000011";
  const defaultNumberId = "20000000-0000-4000-8000-000000000012";
  const laterFieldId = "20000000-0000-4000-8000-000000000013";
  const customFieldId = "20000000-0000-4000-8000-000000000014";
  const secondAssetFieldId = "20000000-0000-4000-8000-000000000015";
  const secondCustomFieldId = "20000000-0000-4000-8000-000000000016";
  const assetId = "40000000-0000-4000-8000-000000000001";
  const secondAssetId = "40000000-0000-4000-8000-000000000002";
  const thirdAssetId = "40000000-0000-4000-8000-000000000003";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  assert.equal(await store.createField({id: defaultTextId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}, defaultValue: "黄阶"}), true);
  assert.equal(await store.createField({id: defaultNumberId, owner: {kind: "type", id: typeId}, title: "年限", valueType: "number", config: {}, defaultValue: 0}), true);

  assert.equal(await store.createAsset({id: assetId, name: "青云诀", description: "主角功法", typeId}), true);
  assert.equal(store.getSnapshot().selectedAssetId, assetId);
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0], "color"), false, "assets without a custom color inherit the theme surface");
  assert.deepEqual(plain(store.getSnapshot().assets[0].values), {[defaultTextId]: "黄阶", [defaultNumberId]: 0});
  assert.equal(await store.createAsset({
    id: secondAssetId, name: "烈火诀", description: "显式清空默认", typeId,
    values: {[defaultTextId]: null, [defaultNumberId]: 7},
  }), true);
  assert.deepEqual(plain(store.getSnapshot().assets[1].values), {[defaultTextId]: null, [defaultNumberId]: 7});

  assert.equal(await store.createField({id: laterFieldId, owner: {kind: "type", id: typeId}, title: "门派", valueType: "text", config: {}, defaultValue: "青云宗"}), true);
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0].values, laterFieldId), false, "new template fields do not backfill existing assets");
  assert.equal(await store.createAsset({id: thirdAssetId, name: "新功法", description: "后创建", typeId}), true);
  assert.equal(store.getSnapshot().assets[2].values[laterFieldId], "青云宗");

  assert.equal(await store.createField({id: customFieldId, owner: {kind: "asset", id: assetId}, title: "个人备注", valueType: "text", config: {}, defaultValue: "单资产"}), true);
  assert.equal(await store.createField({id: secondAssetFieldId, owner: {kind: "asset", id: assetId}, title: "附加说明", valueType: "text", config: {}}), true);
  assert.equal(await store.createField({id: secondCustomFieldId, owner: {kind: "asset", id: secondAssetId}, title: "个人备注", valueType: "text", config: {}}), true,
    "field title and order rules are scoped to their owner asset");
  assert.equal(await store.moveField(customFieldId, 1), true);
  const customFieldOrders = diskSchema(f).fields.filter(field => field.owner.kind === "asset")
    .map(field => [field.owner.id, field.id, field.order])
    .sort((left, right) => left[0].localeCompare(right[0]) || left[2] - right[2]);
  assert.deepEqual(customFieldOrders, [
    [assetId, secondAssetFieldId, 0], [assetId, customFieldId, 1], [secondAssetId, secondCustomFieldId, 0],
  ]);
  assert.equal(store.getSnapshot().assets[0].values[customFieldId], "单资产");
  assert.equal(Object.hasOwn(store.getSnapshot().assets[1].values, customFieldId), false);
  assert.equal(await store.updateAsset(assetId, {values: {[defaultTextId]: "地阶", [customFieldId]: null}}), true);
  assert.deepEqual(plain(store.getSnapshot().assets[0].values), {
    [defaultTextId]: "地阶", [defaultNumberId]: 0, [customFieldId]: null,
  });
  assert.equal(await store.updateAsset(secondAssetId, {values: {[customFieldId]: "不属于此资产"}}), false);
  assert.match(store.getSnapshot().error, /不匹配/);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.deepEqual(diskSchema(f).assets.map(asset => asset.id), [assetId, secondAssetId, thirdAssetId]);

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.deepEqual(plain(reloaded.getSnapshot().assets), plain(store.getSnapshot().assets));
  assert.equal(reloaded.selectAsset(null), true);
  assert.equal(reloaded.getSnapshot().selectedAssetId, null);
  assert.equal(reloaded.selectAsset("not-an-asset"), false);
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("version 1 schema reads unchanged and template edits migrate only the dedicated list", async () => {
  const legacy = legacySchema([type()], [textField(fieldId, {defaultValue: "黄阶"})]);
  const original = JSON.stringify(legacy);
  const f = byteStorageFixture();
  seedFile(f, path, original);
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().assets), []);
  assert.deepEqual(f.disk.get(f.key("/book", path)), Array.from(new TextEncoder().encode(original)));

  assert.equal(await store.updateType(typeId, {description: "已编辑"}), true);
  assert.deepEqual(diskTemplates(f), [type(typeId, {description: "已编辑"})]);
  assert.deepEqual(f.disk.get(f.key("/book", path)), Array.from(new TextEncoder().encode(original)),
    "template-only edits leave a v1 body file byte-for-byte unchanged");
  store.dispose();
  await controller.dispose();
});

test("version 2 assets without a custom color load without rewriting the file", async () => {
  const original = JSON.stringify(storedSchema([], [], {assets: [
    {id: "40000000-0000-4000-8000-000000000041", name: "旧资产", description: "兼容旧版本", typeId: null, values: {}},
    {id: "40000000-0000-4000-8000-000000000046", name: "旧颜色资产", description: "大小写兼容", typeId: null, color: "#A1b2C3", values: {}},
  ]}));
  const f = byteStorageFixture();
  seedFile(f, path, original);
  const originalBytes = [...f.disk.get(f.key("/book", path))];
  const controller = f.files();
  const store = storeFor(controller.service);

  assert.equal(await store.load(), true);
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0], "color"), false);
  assert.equal(store.getSnapshot().assets[1].color, "#a1b2c3", "persisted colors normalize case in memory");
  assert.deepEqual(f.disk.get(f.key("/book", path)), originalBytes);
  assert.equal(f.calls.some(call => call.command === "save_project_file" || call.command === "create_project_file"), false,
    "loading a legacy v2 asset does not trigger a schema rewrite");
  assert.equal(await store.updateAsset("40000000-0000-4000-8000-000000000041", {description: "显式修改后保存"}), true);
  assert.equal(diskSchema(f).assets[1].color, "#a1b2c3", "the next explicit save writes the canonical lowercase color");

  store.dispose();
  await controller.dispose();
});

test("v3 inline data migrates to template group files on the first body edit", async () => {
  const assetA = {id: "40000000-0000-4000-8000-000000000131", name: "对象 A", description: "", typeId, values: {[fieldId]: "高阶"}};
  const assetB = {id: "40000000-0000-4000-8000-000000000132", name: "对象 B", description: "", typeId: secondTypeId, values: {}};
  const freeAsset = {id: "40000000-0000-4000-8000-000000000133", name: "无分类对象", description: "", typeId: null, values: {}};
  const customField = textField("20000000-0000-4000-8000-000000000131",
    {owner: {kind: "asset", id: assetB.id}, title: "旧备注", defaultValue: "保留"});
  const legacy = currentSchema([assetA, assetB, freeAsset], [
    textField(fieldId),
    textField(secondFieldId, {owner: {kind: "type", id: secondTypeId}, title: "用途"}),
    customField,
  ]);
  const templates = [
    type(typeId, {name: "模板 A", order: 0}),
    type(secondTypeId, {name: "模板 B", order: 1}),
  ];
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(legacy));
  seedFile(f, templatesPath, JSON.stringify(templates));
  const templateBytes = [...f.disk.get(f.key("/book", templatesPath))];
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.updateAsset(assetA.id, {description: "升级时保留其它分组"}), true);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.deepEqual(groupDiskData(f, typeId), {
    assets: [{...assetA, description: "升级时保留其它分组"}],
    fields: [textField(fieldId)],
  });
  assert.deepEqual(groupDiskData(f, secondTypeId), {assets: [assetB], fields: [
    textField(secondFieldId, {owner: {kind: "type", id: secondTypeId}, title: "用途"}),
    customField,
  ]});
  assert.deepEqual(groupDiskData(f, null), {assets: [freeAsset], fields: []});
  assert.deepEqual(f.disk.get(f.key("/book", templatesPath)), templateBytes);
  assert.deepEqual(plain(store.getSnapshot().assets), [ {...assetA, description: "升级时保留其它分组"}, assetB, freeAsset ]);

  store.dispose();
  await controller.dispose();
});

test("a template loads its group by ID and creates an absent group on the first edit", async () => {
  const asset = {id: "40000000-0000-4000-8000-000000000109", name: "待保存", description: "", typeId, values: {}};
  for (const existing of [false, true]) {
    const fixture = byteStorageFixture();
    seedFile(fixture, templatesPath, JSON.stringify([type()]));
    if (existing) seedGroup(fixture, typeId, [asset]);
    const controller = fixture.files();
    const store = storeFor(controller.service);
    assert.equal(await store.load(), true);
    assert.deepEqual(plain(store.getSnapshot().assets), existing ? [asset] : []);
    assert.equal(fixture.disk.has(fixture.key("/book", groupPath(typeId))), existing);
    assert.equal(await store.createAsset(asset), true);
    assert.deepEqual(groupDiskData(fixture, typeId).assets, [asset]);
    assert.equal(fixture.disk.has(fixture.key("/book", path)), false);
    await store.dispose();
    await controller.dispose();
  }
});

test("v4 membership is ignored and the obsolete list is removed on the next group save", async () => {
  const fixture = byteStorageFixture();
  seedFile(fixture, templatesPath, JSON.stringify([type(), type(secondTypeId, {name: "地点", order: 1})]));
  seedFile(fixture, path, JSON.stringify(manifestSchema([secondTypeId])));
  seedGroup(fixture, typeId, [], [textField()]);
  const controller = fixture.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.deepEqual(plain(store.getSnapshot().fields), [textField()]);
  assert.equal(await store.renameField(fieldId, "等级"), true);
  assert.equal(groupDiskData(fixture, typeId).fields[0].title, "等级");
  assert.equal(fixture.disk.has(fixture.key("/book", path)), false);
  assert.equal(groupDiskData(fixture, secondTypeId), null);
  await store.dispose();
  await controller.dispose();
});

test("assets and fields persist per template group, including cross-template references", async () => {
  const templateAAssetId = "40000000-0000-4000-8000-000000000101";
  const templateBAssetId = "40000000-0000-4000-8000-000000000102";
  const unclassifiedAssetId = "40000000-0000-4000-8000-000000000103";
  const templateAFieldId = "20000000-0000-4000-8000-000000000101";
  const templateBFieldId = "20000000-0000-4000-8000-000000000102";
  const referenceFieldId = "20000000-0000-4000-8000-000000000103";
  const unclassifiedFieldId = "20000000-0000-4000-8000-000000000104";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.createType({id: typeId, name: "模板 A", description: ""}), true);
  assert.equal(await store.createType({id: secondTypeId, name: "模板 B", description: ""}), true);

  assert.equal(await store.createField({id: templateAFieldId, owner: {kind: "type", id: typeId},
    title: "等级", valueType: "text", config: {}, defaultValue: "初阶"}), true);
  assert.equal(await store.createField({id: templateBFieldId, owner: {kind: "type", id: secondTypeId},
    title: "名称", valueType: "text", config: {}, defaultValue: "乙"}), true);
  assert.equal(await store.createAsset({id: templateBAssetId, name: "对象 B", description: "", typeId: secondTypeId}), true);
  assert.equal(await store.createField({id: referenceFieldId, owner: {kind: "type", id: typeId},
    title: "目标", valueType: "reference", config: {targetTypeId: secondTypeId}}), true);
  assert.equal(await store.createAsset({id: templateAAssetId, name: "对象 A", description: "", typeId}), true);
  assert.equal(await store.updateAsset(templateAAssetId, {values: {[referenceFieldId]: templateBAssetId}}), true);
  assert.equal(await store.createAsset({id: unclassifiedAssetId, name: "未分类对象", description: "", typeId: null}), true);
  assert.equal(await store.createField({id: unclassifiedFieldId, owner: {kind: "asset", id: unclassifiedAssetId},
    title: "备注", valueType: "text", config: {}, defaultValue: "散件"}), true);

  assert.deepEqual(groupDiskData(f, typeId).assets.map(asset => asset.id), [templateAAssetId]);
  assert.deepEqual(groupDiskData(f, typeId).fields.map(field => field.id), [templateAFieldId, referenceFieldId]);
  assert.deepEqual(groupDiskData(f, secondTypeId).assets.map(asset => asset.id), [templateBAssetId]);
  assert.deepEqual(groupDiskData(f, secondTypeId).fields.map(field => field.id), [templateBFieldId]);
  assert.deepEqual(groupDiskData(f, null).assets.map(asset => asset.id), [unclassifiedAssetId]);
  assert.deepEqual(groupDiskData(f, null).fields.map(field => field.id), [unclassifiedFieldId]);

  const otherGroupBefore = f.disk.get(f.key("/book", groupPath(secondTypeId)));
  const unclassifiedBefore = f.disk.get(f.key("/book", groupPath(null)));
  const manifestBefore = f.disk.get(f.key("/book", path));
  const previousCalls = f.calls.length;
  const other = store.getSnapshot().assets.find(asset => asset.id === templateBAssetId);
  validationWatch.objects.add(other.values);
  validationWatch.rejectEntries = true;
  try { assert.equal(await store.updateAsset(templateAAssetId, {description: "只改模板 A"}), true); }
  finally { validationWatch.rejectEntries = false; }
  assert.strictEqual(store.getSnapshot().assets.find(asset => asset.id === templateBAssetId), other);
  const writes = f.calls.slice(previousCalls)
    .filter(call => ["create_project_file", "save_project_file"].includes(call.command))
    .map(call => call.args.path);
  assert.deepEqual(writes, [groupPath(typeId)], "editing A writes only A's object group file");
  assert.deepEqual(f.disk.get(f.key("/book", groupPath(secondTypeId))), otherGroupBefore);
  assert.deepEqual(f.disk.get(f.key("/book", groupPath(null))), unclassifiedBefore);
  assert.deepEqual(f.disk.get(f.key("/book", path)), manifestBefore);

  const reopened = storeFor(controller.service);
  assert.equal(await reopened.load(), true);
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === templateAAssetId).description, "只改模板 A");
  assert.equal(reopened.getSnapshot().assets.find(asset => asset.id === templateAAssetId).values[referenceFieldId], templateBAssetId);
  assert.deepEqual(plain(reopened.getSnapshot().fields.map(field => field.id).sort()),
    [templateAFieldId, referenceFieldId, templateBFieldId, unclassifiedFieldId].sort());

  store.dispose();
  reopened.dispose();
  await controller.dispose();
});

test("asset colors normalize, persist, survive updates, and clear only when explicitly null", async () => {
  const assetId = "40000000-0000-4000-8000-000000000042";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();

  assert.equal(await store.createAsset({id: assetId, name: "带颜色的资产", description: "颜色由用户选择", typeId: null, color: "#Ab12Cd"}), true);
  const created = store.getSnapshot().assets[0];
  assert.equal(created.color, "#ab12cd");
  assert.equal(Object.isFrozen(created), true);
  assert.equal(diskSchema(f).assets[0].color, "#ab12cd");

  assert.equal(await store.updateAsset(assetId, {description: "只改说明"}), true);
  assert.equal(store.getSnapshot().assets[0].color, "#ab12cd", "omitting color preserves the selected color");
  assert.equal(diskSchema(f).assets[0].color, "#ab12cd");

  assert.equal(await store.updateAsset(assetId, {color: "#D0E1F2"}), true);
  assert.equal(store.getSnapshot().assets[0].color, "#d0e1f2");
  assert.equal(diskSchema(f).assets[0].color, "#d0e1f2");

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().assets[0].color, "#d0e1f2", "reopening restores the normalized color");

  assert.equal(await store.updateAsset(assetId, {color: null}), true);
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0], "color"), false, "null clears the optional property");
  assert.equal(Object.hasOwn(diskSchema(f).assets[0], "color"), false, "cleared color is omitted from the saved schema");
  assert.equal(await reloaded.load(), true);
  assert.equal(Object.hasOwn(reloaded.getSnapshot().assets[0], "color"), false, "shared refresh observes the cleared color");

  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("invalid asset colors are rejected before changing the schema", async () => {
  const assetId = "40000000-0000-4000-8000-000000000043";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createAsset({id: assetId, name: "原资产", description: "", typeId: null}), true);
  const before = diskSchema(f);

  assert.equal(await store.createAsset({id: "40000000-0000-4000-8000-000000000044", name: "错误颜色", description: "", typeId: null, color: "#12FG00"}), false);
  assert.match(store.getSnapshot().error, /#RRGGBB/);
  assert.equal(await store.updateAsset(assetId, {color: "red"}), false);
  assert.match(store.getSnapshot().error, /#RRGGBB/);
  assert.deepEqual(diskSchema(f), before, "invalid colors never reach ProjectFiles.write");
  assert.equal(store.getSnapshot().assets.length, 1, "rejected creation does not add an asset");

  store.dispose();
  await controller.dispose();
});

test("a failed color save keeps the canonical color in the dirty draft until retry", async () => {
  let failSave = false;
  const assetId = "40000000-0000-4000-8000-000000000045";
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("颜色暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createAsset({id: assetId, name: "待着色资产", description: "", typeId: null}), true);
  const groupBytes = [...f.disk.get(f.key("/book", groupPath(null)))];

  failSave = true;
  assert.equal(await store.updateAsset(assetId, {color: "#AABBCC"}), false);
  assert.equal(store.getSnapshot().assets[0].color, "#aabbcc");
  assert.equal(store.getSnapshot().dirty, true);
  const buffered = controller.service.getSnapshot().files.find(file => file.path === groupPath(null));
  assert.equal(JSON.parse(new TextDecoder().decode(new Uint8Array(buffered.bytes))).assets[0].color, "#aabbcc");
  assert.deepEqual(f.disk.get(f.key("/book", groupPath(null))), groupBytes, "failed group save preserves previous object bytes");
  assert.equal(f.disk.has(f.key("/book", path)), false);

  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().dirty, false);
  assert.equal(diskSchema(f).assets[0].color, "#aabbcc");
  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().assets[0].color, "#aabbcc");

  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("reference properties require a stored asset of the configured target type", async () => {
  const referenceFieldId = "20000000-0000-4000-8000-000000000021";
  const targetAssetId = "40000000-0000-4000-8000-000000000011";
  const sourceAssetId = "40000000-0000-4000-8000-000000000012";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.createType({id: typeId, name: "功法", description: "修炼方法"});
  await store.createType({id: secondTypeId, name: "人物", description: "故事人物"});
  assert.equal(await store.createField({
    id: referenceFieldId, owner: {kind: "type", id: typeId}, title: "创立者", valueType: "reference", config: {targetTypeId: secondTypeId},
  }), true);
  assert.equal(await store.createAsset({id: targetAssetId, name: "师尊", description: "创立者", typeId: secondTypeId}), true);
  assert.equal(await store.createAsset({
    id: sourceAssetId, name: "功法", description: "有创立者", typeId, values: {[referenceFieldId]: targetAssetId},
  }), true);
  const before = diskSchema(f);
  assert.equal(await store.updateAsset(sourceAssetId, {values: {[referenceFieldId]: sourceAssetId}}), false);
  assert.match(store.getSnapshot().error, /关联值/);
  assert.equal(await store.updateAsset(sourceAssetId, {values: {[referenceFieldId]: "40000000-0000-4000-8000-000000000099"}}), false);
  assert.match(store.getSnapshot().error, /关联值/);
  assert.deepEqual(diskSchema(f), before);
  store.dispose();
  await controller.dispose();
});

test("failed asset creation retains its record and retry saves it once", async () => {
  let failCreate = true;
  const assetId = "40000000-0000-4000-8000-000000000021";
  const input = {id: assetId, name: "暂存资产", description: "创建失败后保留", typeId: null, color: "#C0FFEE", values: {}};
  const f = byteStorageFixture({onInvoke(command) {
    if (failCreate && command === "create_project_file") throw new Error("资产文件暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();

  assert.equal(await store.createAsset(input), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(plain(store.getSnapshot().assets), [{id: assetId, name: "暂存资产", description: "创建失败后保留", typeId: null, color: "#c0ffee", values: {}}]);
  failCreate = false;
  assert.equal(await store.createAsset(input), true, "same-ID retry flushes the retained asset rather than adding another");
  assert.deepEqual(diskSchema(f).assets, [{id: assetId, name: "暂存资产", description: "创建失败后保留", typeId: null, color: "#c0ffee", values: {}}]);
  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().assets[0].color, "#c0ffee", "idempotent create retry keeps the color through reload");
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("asset deletion blocks only real external references and removes only its custom fields", async () => {
  const textFieldId = "20000000-0000-4000-8000-000000000031";
  const referenceFieldId = "20000000-0000-4000-8000-000000000032";
  const victimFieldId = "20000000-0000-4000-8000-000000000033";
  const victimFieldId2 = "20000000-0000-4000-8000-000000000034";
  const otherFieldId = "20000000-0000-4000-8000-000000000035";
  const victimId = "50000000-0000-4000-8000-000000000001";
  const referencingId = "50000000-0000-4000-8000-000000000002";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.createType({id: typeId, name: "人物", description: "故事人物"});
  assert.equal(await store.createField({id: textFieldId, owner: {kind: "type", id: typeId}, title: "备注", valueType: "text", config: {}}), true);
  assert.equal(await store.createField({id: referenceFieldId, owner: {kind: "type", id: typeId}, title: "关联人物", valueType: "reference", config: {targetTypeId: typeId}}), true);
  assert.equal(await store.createAsset({id: victimId, name: "被引用者", description: "自身引用自己", typeId,
    values: {[textFieldId]: victimId, [referenceFieldId]: victimId}}), true);
  assert.equal(await store.createAsset({id: referencingId, name: "引用者", description: "关联被引用者", typeId,
    values: {[textFieldId]: victimId, [referenceFieldId]: victimId}}), true);
  assert.equal(await store.createField({id: victimFieldId, owner: {kind: "asset", id: victimId}, title: "专属备注", valueType: "text", config: {}, defaultValue: "保留到删除"}), true);
  assert.equal(await store.createField({id: victimFieldId2, owner: {kind: "asset", id: victimId}, title: "专属标签", valueType: "text", config: {}}), true);
  assert.equal(await store.createField({id: otherFieldId, owner: {kind: "asset", id: referencingId}, title: "引用者备注", valueType: "text", config: {}}), true);

  store.selectAsset(victimId);
  assert.equal(await store.removeAsset(victimId), false);
  assert.match(store.getSnapshot().error, /引用者/);
  assert.deepEqual(diskSchema(f).assets.map(asset => asset.id), [victimId, referencingId]);

  assert.equal(await store.removeAssetField(victimId, textFieldId), false, "template fields cannot be removed through the asset-field API");
  assert.equal(await store.removeAssetField(victimId, otherFieldId), false, "another asset's custom field cannot be removed");
  assert.equal(await store.removeAssetField("50000000-0000-4000-8000-000000000099", victimFieldId), false, "the owner asset must exist");
  assert.equal(await store.removeAssetField(victimId, victimFieldId), true);
  assert.equal(await store.removeAssetField(victimId, victimFieldId), true, "repeating the field removal is harmless");
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0].values, victimFieldId), false);
  assert.equal(store.getSnapshot().fields.some(field => field.id === textFieldId), true);
  assert.equal(store.getSnapshot().fields.some(field => field.id === otherFieldId), true);
  assert.equal(store.getSnapshot().assets[1].values[textFieldId], victimId, "text that happens to equal an asset ID is not a reference");
  assert.equal(await store.updateAsset(referencingId, {values: {[referenceFieldId]: referencingId}}), true);
  assert.equal(await store.removeAsset(victimId), true, "self-reference does not prevent deleting its own record");
  assert.deepEqual(plain(store.getSnapshot().assets.map(asset => asset.id)), [referencingId]);
  assert.equal(store.getSnapshot().selectedAssetId, referencingId);
  assert.equal(store.getSnapshot().assets[0].values[textFieldId], victimId, "other asset values are unchanged");
  assert.equal(store.getSnapshot().assets[0].values[referenceFieldId], referencingId);
  assert.equal(store.getSnapshot().fields.some(field => field.id === victimFieldId2), false);
  assert.equal(store.getSnapshot().fields.some(field => field.id === otherFieldId), true);
  assert.equal(await store.removeAsset(victimId), true, "repeating the asset removal is harmless");

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.deepEqual(plain(reloaded.getSnapshot().assets.map(asset => asset.id)), [referencingId]);
  assert.equal(reloaded.getSnapshot().selectedAssetId, referencingId);
  assert.equal(reloaded.getSnapshot().fields.some(field => field.id === textFieldId), true);
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("failed asset and custom-field deletions stay deleted through retry and reload", async () => {
  let failSave = false;
  const assetFieldId = "20000000-0000-4000-8000-000000000041";
  const removedAssetId = "50000000-0000-4000-8000-000000000011";
  const keptAssetId = "50000000-0000-4000-8000-000000000012";
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("删除保存失败");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createAsset({id: removedAssetId, name: "待删资产", description: "", typeId: null}), true);
  assert.equal(await store.createAsset({id: keptAssetId, name: "保留资产", description: "", typeId: null}), true);
  assert.equal(await store.createField({id: assetFieldId, owner: {kind: "asset", id: removedAssetId}, title: "专属值", valueType: "text", config: {}, defaultValue: "删除"}), true);

  failSave = true;
  assert.equal(await store.removeAssetField(removedAssetId, assetFieldId), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().fields.some(field => field.id === assetFieldId), false);
  assert.equal(Object.hasOwn(store.getSnapshot().assets[0].values, assetFieldId), false);
  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(diskSchema(f).fields.some(field => field.id === assetFieldId), false);

  store.selectAsset(removedAssetId);
  failSave = true;
  assert.equal(await store.removeAsset(removedAssetId), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(plain(store.getSnapshot().assets.map(asset => asset.id)), [keptAssetId]);
  failSave = false;
  assert.equal(await store.retry(), true);
  assert.deepEqual(diskSchema(f).assets.map(asset => asset.id), [keptAssetId]);

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.deepEqual(plain(reloaded.getSnapshot().assets.map(asset => asset.id)), [keptAssetId]);
  assert.equal(reloaded.getSnapshot().selectedAssetId, keptAssetId);
  assert.equal(reloaded.getSnapshot().fields.some(field => field.id === assetFieldId), false);
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("type deletion is blocked by assets assigned to active or archived types", async () => {
  const archivedTypeId = secondTypeId;
  const assetId = "60000000-0000-4000-8000-000000000001";
  const stored = storedSchema([
    type(typeId, {order: 0}),
    type(archivedTypeId, {name: "旧类型", order: 1, status: "archived"}),
  ], [], {assets: [{id: assetId, name: "旧资产", description: "仍使用归档类型", typeId: archivedTypeId, values: {}}]});
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(stored));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  const before = diskSchema(f);

  assert.equal(await store.removeType(archivedTypeId), false);
  assert.match(store.getSnapshot().error, /旧资产/);
  assert.match(store.getSnapshot().error, /原数据已保留/);
  assert.deepEqual(diskSchema(f), before);
  assert.deepEqual(plain(store.getSnapshot().assets), plain(before.assets));
  assert.deepEqual(plain(store.getSnapshot().types), plain(before.types));
  store.dispose();
  await controller.dispose();
});

test("type deletion is blocked by external archived and asset-owned reference fields", async () => {
  const targetTypeId = secondTypeId;
  const assetOwnerId = "60000000-0000-4000-8000-000000000011";
  const externalTypeFieldId = "20000000-0000-4000-8000-000000000051";
  const externalAssetFieldId = "20000000-0000-4000-8000-000000000052";
  const selfReferenceFieldId = "20000000-0000-4000-8000-000000000053";
  const externalAssetField = {
    id: externalAssetFieldId, owner: {kind: "asset", id: assetOwnerId}, title: "指向目标类型", valueType: "reference",
    config: {targetTypeId}, order: 0, status: "archived",
  };
  const stored = storedSchema([
    type(typeId, {name: "来源类型", order: 0}),
    type(targetTypeId, {name: "目标类型", order: 1}),
  ], [
    {id: externalTypeFieldId, owner: {kind: "type", id: typeId}, title: "历史关联", valueType: "reference", config: {targetTypeId}, order: 0, status: "archived"},
    externalAssetField,
    {id: selfReferenceFieldId, owner: {kind: "type", id: targetTypeId}, title: "自关联", valueType: "reference", config: {targetTypeId}, order: 0, status: "active"},
  ], {assets: [{id: assetOwnerId, name: "参考资产", description: "持有专属引用字段", typeId: typeId, values: {}}]});
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(stored));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  const before = diskSchema(f);

  assert.equal(await store.removeType(targetTypeId), false);
  assert.match(store.getSnapshot().error, /历史关联/);
  assert.match(store.getSnapshot().error, /指向目标类型/);
  assert.match(store.getSnapshot().error, /参考资产/);
  assert.doesNotMatch(store.getSnapshot().error, /自关联/);
  assert.deepEqual(diskSchema(f), before);
  assert.deepEqual(plain(store.getSnapshot().assets), plain(before.assets));
  assert.deepEqual(plain(store.getSnapshot().fields), plain(before.fields));
  store.dispose();
  await controller.dispose();
});

test("type deletion removes its fields only and selects the lowest-order active survivor", async () => {
  const deletedTypeId = secondTypeId;
  const nextTypeId = typeId;
  const lastTypeId = "10000000-0000-4000-8000-000000000003";
  const selfFieldId = "20000000-0000-4000-8000-000000000061";
  const selfReferenceFieldId = "20000000-0000-4000-8000-000000000062";
  const survivorFieldId = "20000000-0000-4000-8000-000000000063";
  const assetId = "60000000-0000-4000-8000-000000000021";
  const untypedAssetId = "60000000-0000-4000-8000-000000000022";
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.createType({id: deletedTypeId, name: "待删类型", description: "含自关联字段"});
  await store.createType({id: nextTypeId, name: "保留类型", description: "默认选择"});
  await store.createType({id: lastTypeId, name: "其他类型", description: "继续保留"});
  assert.equal(await store.createField({id: selfFieldId, owner: {kind: "type", id: deletedTypeId}, title: "模板文本", valueType: "text", config: {}, defaultValue: "随类型删除"}), true);
  assert.equal(await store.createField({id: selfReferenceFieldId, owner: {kind: "type", id: deletedTypeId}, title: "自关联", valueType: "reference", config: {targetTypeId: deletedTypeId}}), true);
  assert.equal(await store.createField({id: survivorFieldId, owner: {kind: "type", id: nextTypeId}, title: "保留选项", valueType: "singleSelect", config: {options: [{id: optionId, title: "保留"}]}, defaultValue: optionId}), true);
  assert.equal(await store.createAsset({id: assetId, name: "其他类型资产", description: "保留值", typeId: nextTypeId, values: {[survivorFieldId]: optionId}}), true);
  assert.equal(await store.createAsset({id: untypedAssetId, name: "未分类资产", description: "也保留", typeId: null}), true);
  store.selectType(deletedTypeId);
  const beforeAssets = plain(store.getSnapshot().assets);

  assert.equal(await store.removeType(deletedTypeId), true);
  assert.deepEqual(plain(store.getSnapshot().types.map(item => [item.id, item.order])), [[nextTypeId, 1], [lastTypeId, 2]]);
  assert.deepEqual(plain(store.getSnapshot().assets), beforeAssets);
  assert.deepEqual(plain(store.getSnapshot().fields.map(field => field.id)), [survivorFieldId]);
  assert.equal(store.getSnapshot().selectedTypeId, nextTypeId);
  assert.equal(diskSchema(f).fields[0].config.options[0].id, optionId);

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.deepEqual(plain(reloaded.getSnapshot().assets), beforeAssets);
  assert.deepEqual(plain(reloaded.getSnapshot().types.map(item => [item.id, item.order])), [[nextTypeId, 1], [lastTypeId, 2]]);
  assert.equal(reloaded.getSnapshot().selectedTypeId, nextTypeId);
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("failed type deletion stays deleted through retry and reload", async () => {
  let failSave = false;
  const deletedTypeId = secondTypeId;
  const ownedFieldId = "20000000-0000-4000-8000-000000000071";
  const retainedAssetId = "40000000-0000-4000-8000-000000000071";
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("类型删除暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  await store.createType({id: typeId, name: "保留类型", description: "剩余选择"});
  await store.createType({id: deletedTypeId, name: "待删类型", description: "删除失败时保留草稿"});
  await store.createAsset({id: retainedAssetId, name: "保留资产", description: "颜色应随类型变更保留", typeId, color: "#345678"});
  await store.createField({id: ownedFieldId, owner: {kind: "type", id: deletedTypeId}, title: "专属模板", valueType: "text", config: {}});
  store.selectType(deletedTypeId);

  failSave = true;
  assert.equal(await store.removeType(deletedTypeId), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().types.some(item => item.id === deletedTypeId), true,
    "the list entry stays until its owned fields are durably removed");
  assert.equal(store.getSnapshot().fields.some(field => field.id === ownedFieldId), false);
  assert.equal(store.getSnapshot().assets[0].color, "#345678", "removing another type preserves asset color");
  assert.equal(store.getSnapshot().selectedTypeId, typeId);
  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(diskSchema(f).types.some(item => item.id === deletedTypeId), false);
  assert.equal(diskSchema(f).fields.some(field => field.id === ownedFieldId), false);
  assert.equal(diskSchema(f).assets[0].color, "#345678");

  const reloaded = storeFor(controller.service);
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.getSnapshot().types.some(item => item.id === deletedTypeId), false);
  assert.equal(reloaded.getSnapshot().fields.some(field => field.id === ownedFieldId), false);
  assert.equal(reloaded.getSnapshot().assets[0].color, "#345678", "retry and reload retain the unrelated asset color");
  assert.equal(reloaded.getSnapshot().selectedTypeId, typeId);
  store.dispose();
  reloaded.dispose();
  await controller.dispose();
});

test("duplicate active names are rejected and same-ID create retries are idempotent", async () => {
  let failCreate = true;
  const f = byteStorageFixture({onInvoke(command) {
    if (failCreate && command === "create_project_file") throw new Error("资产目录暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();

  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.deepEqual(plain(store.getSnapshot().types).map(item => item.id), [typeId]);
  assert.equal(await store.createType({id: secondTypeId, name: "功法", description: "重复"}), false);
  assert.match(store.getSnapshot().error, /同名/);

  failCreate = false;
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  assert.deepEqual(diskTemplates(f), [type()]);
  assert.equal(store.getSnapshot().dirty, false);
  assert.equal(await store.createType({id: typeId, name: "其他", description: "不同内容"}), false);
  assert.equal(diskTemplates(f).length, 1, "an ID collision never creates a second type");

  store.dispose();
  await controller.dispose();
});

test("field definitions validate IDs, owner, select defaults, and title uniqueness", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(storedSchema([type()])));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: secondTypeId}, title: "未知类型字段", valueType: "text", config: {}}), false);
  assert.match(store.getSnapshot().error, /所属类型/);
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "singleSelect", config: {options: [{id: optionId, title: "黄阶"}]}, defaultValue: "不存在的选项"}), false);
  assert.match(store.getSnapshot().error, /默认值/);
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}}), true);
  assert.equal(await store.createField({id: secondFieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "number", config: {}}), false);
  assert.match(store.getSnapshot().error, /同名/);
  assert.equal(await store.renameField(fieldId, ""), false);
  assert.match(store.getSnapshot().error, /不能为空/);
  assert.equal(diskSchema(f).fields.length, 1);

  store.dispose();
  await controller.dispose();
});

test("invalid UTF-8, malformed JSON, unsupported schema, and invalid references are preserved", async t => {
  const cases = [
    ["invalid UTF-8", [0xc3, 0x28]],
    ["malformed JSON", "{"],
    ["unsupported version", JSON.stringify(storedSchema([], [], {schemaVersion: 99}))],
    ["invalid persisted asset color", JSON.stringify(storedSchema([], [], {assets: [
      {id: "40000000-0000-4000-8000-000000000047", name: "坏颜色", description: "", typeId: null, color: "#12GG00", values: {}},
    ]}))],
    ["unknown owner reference", JSON.stringify(storedSchema([type()], [textField(fieldId, {owner: {kind: "type", id: secondTypeId}})]))],
    ["reused option ID", JSON.stringify(storedSchema([type()], [
      textField(fieldId, {valueType: "singleSelect", config: {options: [{id: fieldId, title: "黄阶"}]}}),
    ]))],
    ["duplicate field order", JSON.stringify(storedSchema([type()], [textField(), textField(secondFieldId, {title: "效果", order: 0})]))],
    ["wrong default type", JSON.stringify(storedSchema([type()], [textField(fieldId, {valueType: "number", defaultValue: "四"})]))],
    ["type name too long", JSON.stringify(storedSchema([type(typeId, {name: "类".repeat(61)})]))],
    ["type description too long", JSON.stringify(storedSchema([type(typeId, {description: "述".repeat(201)})]))],
    ["field title too long", JSON.stringify(storedSchema([type()], [textField(fieldId, {title: "字段".repeat(31)})]))],
    ["option title too long", JSON.stringify(storedSchema([type()], [textField(fieldId, {
      valueType: "singleSelect", config: {options: [{id: optionId, title: "选".repeat(61)}]},
    })]))],
    ["select option list empty", JSON.stringify(storedSchema([type()], [textField(fieldId, {
      valueType: "singleSelect", config: {options: []},
    })]))],
    ["too many options", JSON.stringify(storedSchema([type()], [textField(fieldId, {
      valueType: "singleSelect", config: {options: Array.from({length: 101}, (_, index) => ({
        id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, title: `选项${index + 1}`,
      }))},
    })]))],
  ];
  for (const [name, content] of cases) {
    await t.test(name, async () => {
      const f = byteStorageFixture();
      seedFile(f, path, content);
      const original = [...f.disk.get(f.key("/book", path))];
      const controller = f.files();
      const store = storeFor(controller.service);
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().blocked, true);
      assert.equal(await store.createType({id: typeId, name: "不应写入", description: ""}), false);
      assert.deepEqual(f.disk.get(f.key("/book", path)), original);
      assert.equal(f.calls.some(call => call.command === "create_project_file" || call.command === "save_project_file"), false);
      store.dispose();
      await controller.dispose();
    });
  }
});

test("legacy migration saves each group before removing the old schema and resumes after reopening", async () => {
  const assetA = {id: "40000000-0000-4000-8000-000000000111", name: "旧对象 A", description: "", typeId, values: {[fieldId]: "地阶"}};
  const assetB = {id: "40000000-0000-4000-8000-000000000112", name: "旧对象 B", description: "", typeId: secondTypeId, values: {[secondFieldId]: "丙"}};
  const unclassifiedId = "40000000-0000-4000-8000-000000000113";
  const unclassifiedAsset = {id: unclassifiedId, name: "旧未分类", description: "", typeId: null, values: {[optionId]: "散件"}};
  const legacy = storedSchema([
    type(typeId, {name: "模板 A", order: 0}),
    type(secondTypeId, {name: "模板 B", order: 1}),
  ], [
    textField(fieldId, {defaultValue: "初阶"}),
    textField(secondFieldId, {owner: {kind: "type", id: secondTypeId}, title: "品级", defaultValue: "甲"}),
    textField(optionId, {owner: {kind: "asset", id: unclassifiedId}, title: "出处"}),
  ], {assets: [assetA, assetB, unclassifiedAsset]});
  let failGroupB = true;
  const f = byteStorageFixture({onInvoke(command, args) {
    if (failGroupB && command === "create_project_file" && args.path === groupPath(secondTypeId)) {
      failGroupB = false;
      throw new Error("模板 B 的分组文件创建失败");
    }
  }});
  seedFile(f, path, JSON.stringify(legacy));
  seedFile(f, templatesPath, JSON.stringify(legacy.types));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);
  assert.equal(await store.updateAsset(assetA.id, {description: "中断前的改动"}), false);
  assert.deepEqual(f.disk.get(f.key("/book", path)), Array.from(new TextEncoder().encode(JSON.stringify(legacy))),
    "the v2 source remains authoritative until every baseline group file exists");
  assert.ok(groupDiskData(f, typeId), "a completed baseline group can remain as an unlisted resumable file");
  assert.equal(f.disk.has(f.key("/book", groupPath(secondTypeId))), false);
  assert.equal(f.disk.has(f.key("/book", groupPath(null))), false);

  store.dispose();
  await controller.dispose();
  const resumedController = f.files();
  const resumed = storeFor(resumedController.service);
  assert.equal(await resumed.load(), true);
  assert.deepEqual(plain(resumed.getSnapshot().assets), plain(legacy.assets),
    "unlisted partial files do not hide legacy data after restart");
  assert.equal(await resumed.updateAsset(assetA.id, {description: "恢复后再编辑"}), true);
  assert.equal(f.disk.has(f.key("/book", path)), false);
  assert.deepEqual(groupDiskData(f, typeId).assets, [{...assetA, description: "恢复后再编辑"}]);
  assert.deepEqual(groupDiskData(f, secondTypeId).assets, [assetB]);
  assert.deepEqual(groupDiskData(f, null).assets, [unclassifiedAsset]);
  assert.equal(diskSchema(f).assets.length, 3);

  resumed.dispose();
  await resumedController.dispose();
});

test("template edits validate template metadata and reject IDs used by fields", async () => {
  const f = byteStorageFixture();
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}}), true);
  const before = diskSchema(f);

  assert.equal(await store.createType({id: fieldId, name: "ID冲突", description: ""}), false);
  assert.match(store.getSnapshot().error, /ID 重复/);
  assert.equal(await store.updateType(typeId, {name: "类".repeat(61)}), false);
  assert.match(store.getSnapshot().error, /1 到 60/);
  assert.equal(await store.updateType(typeId, {description: "述".repeat(201)}), false);
  assert.match(store.getSnapshot().error, /最多 200/);
  assert.equal(await store.renameField(fieldId, "字段".repeat(31)), false);
  assert.match(store.getSnapshot().error, /1 到 60/);
  assert.deepEqual(diskSchema(f), before, "invalid candidates never reach ProjectFiles.write");

  assert.equal(await store.createField({id: secondFieldId, owner: {kind: "type", id: typeId}, title: "流派", valueType: "singleSelect", config: {options: []}}), false);
  assert.match(store.getSnapshot().error, /选项数量/);
  assert.equal(diskSchema(f).fields.length, 1);
  store.dispose();
  await controller.dispose();
});

test("same-value edits retry failed saves instead of reporting success", async () => {
  let failSave = false;
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("磁盘暂不可写");
  }});
  seedFile(f, path, JSON.stringify(storedSchema([type()], [textField()])));
  seedFile(f, templatesPath, JSON.stringify([type()]));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  failSave = true;
  assert.equal(await store.updateType(typeId, {name: "术法"}), false);
  assert.equal(await store.updateType(typeId, {name: "术法"}), false, "same-value edit retries and reports the pending save failure");
  failSave = false;
  assert.equal(await store.updateType(typeId, {name: "术法"}), true);
  assert.equal(diskTemplates(f)[0].name, "术法");

  failSave = true;
  assert.equal(await store.renameField(fieldId, "境界"), false);
  assert.equal(await store.renameField(fieldId, "境界"), false);
  failSave = false;
  assert.equal(await store.renameField(fieldId, "境界"), true);
  assert.equal(diskSchema(f).fields[0].title, "境界");
  assert.equal(store.getSnapshot().dirty, false);

  store.dispose();
  await controller.dispose();
});

test("failed new IDs can be corrected and retried once, but saved IDs remain protected", async () => {
  let failCreate = true;
  const f = byteStorageFixture({onInvoke(command) {
    if (failCreate && command === "create_project_file") throw new Error("创建暂不可用");
  }});
  seedFile(f, path, JSON.stringify(storedSchema()));
  const controller = f.files();
  const store = storeFor(controller.service);
  assert.equal(await store.load(), true);

  assert.equal(await store.createType({id: typeId, name: "功法", description: "初始说明"}), false);
  failCreate = false;
  assert.equal(await store.createType({id: typeId, name: "术法", description: "修订说明"}), true);
  assert.deepEqual(diskTemplates(f), [type(typeId, {name: "术法", description: "修订说明"})]);
  assert.equal(await store.createType({id: typeId, name: "已保存后改名", description: "不应覆盖"}), false);

  failCreate = true;
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "品阶", valueType: "text", config: {}}), false);
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "修为", valueType: "text", config: {}, defaultValue: "筑基"}), false);
  failCreate = false;
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "修为", valueType: "text", config: {}, defaultValue: "筑基"}), true);
  assert.deepEqual(diskSchema(f).fields, [textField(fieldId, {title: "修为", defaultValue: "筑基"})]);
  assert.equal(await store.createField({id: fieldId, owner: {kind: "type", id: typeId}, title: "已保存后改标题", valueType: "text", config: {}}), false);
  assert.equal(diskSchema(f).fields.length, 1);

  store.dispose();
  await controller.dispose();
});

test("save failure keeps the template list bytes dirty and retry flushes the accepted list", async () => {
  let failSave = false;
  const f = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("磁盘暂不可写");
  }});
  const controller = f.files();
  const store = storeFor(controller.service);
  await store.load();
  assert.equal(await store.createType({id: typeId, name: "功法", description: "修炼方法"}), true);

  failSave = true;
  assert.equal(await store.updateType(typeId, {name: "术法"}), false);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().saveState, "error");
  const buffered = controller.service.getSnapshot().files.find(file => file.path === templatesPath);
  assert.equal(buffered.dirty, true);
  assert.equal(JSON.parse(new TextDecoder().decode(new Uint8Array(buffered.bytes)))[0].name, "术法");

  assert.equal(await store.updateType(typeId, {name: "新术法"}), false, "a failed edit can be corrected before retry");
  assert.equal(store.getSnapshot().types[0].name, "新术法");
  failSave = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().dirty, false);
  assert.equal(diskTemplates(f)[0].name, "新术法");
  store.dispose();
  await controller.dispose();
});

test("shared ProjectFiles bytes remain canonical across stores while a save is in flight", async () => {
  const entered = deferred();
  const release = deferred();
  let pauseSave = false;
  const f = byteStorageFixture({async onInvoke(command) {
    if (pauseSave && command === "save_project_file") {
      pauseSave = false;
      entered.resolve();
      await release.promise;
    }
  }});
  const controller = f.files();
  const first = storeFor(controller.service);
  await first.load();
  await first.createType({id: typeId, name: "功法", description: "修炼方法"});
  const second = storeFor(controller.service);
  assert.equal(await second.load(), true);
  assert.deepEqual(plain(second.getSnapshot().types), [type()]);

  pauseSave = true;
  const pending = first.updateType(typeId, {description: "先天术法"});
  await entered.promise;
  assert.equal(second.getSnapshot().types[0].description, "先天术法", "shared bytes notify other stores immediately");
  release.resolve();
  assert.equal(await pending, true);
  assert.equal(await second.updateType(typeId, {name: "术法"}), true);
  assert.deepEqual(diskTemplates(f), [type(typeId, {name: "术法", description: "先天术法"})]);

  first.dispose();
  second.dispose();
  await controller.dispose();
});

test("dispose cancels in-flight loading and prevents late notifications", async () => {
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
  seedFile(f, path, JSON.stringify(storedSchema([type()])));
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
  assert.equal(await store.createType({id: typeId, name: "不应写入", description: ""}), false);
  await controller.dispose();
});

test("disposing synchronously from the protected-file loading notification skips parsing and stale writes", async () => {
  const f = byteStorageFixture();
  seedFile(f, path, JSON.stringify(storedSchema([type()])));
  const controller = f.files();
  assert.ok(await controller.service.read(path));

  const service = projectFilesWithOverlay(controller.service, () => ({dirty: true, saveState: "saving"}));
  const store = storeFor(service);
  let disposedSnapshot;
  store.subscribe(() => {
    if (!store.getSnapshot().loading) return;
    store.dispose();
    disposedSnapshot = store.getSnapshot();
  });
  const beforeLoad = parseStats.decodes;

  assert.equal(await store.load(), false);
  assert.equal(parseStats.decodes - beforeLoad, 0, "protected bytes are not parsed after synchronous disposal");
  assert.ok(disposedSnapshot);
  assert.strictEqual(store.getSnapshot(), disposedSnapshot, "the abandoned load does not publish stale state");
  assert.equal(disposedSnapshot.loading, false);
  assert.equal(disposedSnapshot.saving, false);
  assert.equal(disposedSnapshot.blocked, true);

  await controller.dispose();
});

test("unrelated file notifications reuse parsed asset bytes and publish only changed state", async () => {
  const f = byteStorageFixture();
  seedFile(f, templatesPath, JSON.stringify([type()]));
  seedGroup(f, typeId);
  const controller = f.files();
  let overlay = null;
  const service = projectFilesWithOverlay(controller.service, () => overlay, groupPath(typeId));
  const store = storeFor(service);
  let notifications = 0;
  store.subscribe(() => { notifications++; });
  const beforeLoad = parseStats.decodes;

  assert.equal(await store.load(), true);
  assert.equal(parseStats.decodes - beforeLoad, 1, "the read notification and load result share one parse");
  const loaded = store.getSnapshot();
  const afterLoadNotifications = notifications;

  assert.ok(await controller.service.create(`${directory}/unrelated.json`, [1], {createParents: false}));
  assert.strictEqual(store.getSnapshot(), loaded, "an unrelated file keeps the public snapshot stable");
  assert.equal(parseStats.decodes - beforeLoad, 1);
  assert.equal(notifications, afterLoadNotifications);

  overlay = {saveState: "error", saveError: "保存暂不可用"};
  assert.ok(await controller.service.create(`${directory}/another.json`, [2], {createParents: false}));
  const failedSave = store.getSnapshot();
  assert.notStrictEqual(failedSave, loaded, "a save-state change is still published for the same bytes");
  assert.equal(failedSave.saveState, "error");
  assert.equal(failedSave.error, "保存暂不可用");
  assert.equal(parseStats.decodes - beforeLoad, 1, "save-state changes do not decode unchanged bytes");
  assert.equal(notifications, afterLoadNotifications + 1);

  assert.ok(await controller.service.create(`${directory}/third.json`, [3], {createParents: false}));
  assert.strictEqual(store.getSnapshot(), failedSave, "repeat notifications do not rebuild an unchanged snapshot");
  assert.equal(notifications, afterLoadNotifications + 1);
  assert.equal(parseStats.decodes - beforeLoad, 1);

  store.dispose();
  await controller.dispose();
});

test("unchanged invalid bytes are not reparsed and a repaired group can be retried", async () => {
  const f = byteStorageFixture();
  seedFile(f, templatesPath, JSON.stringify([type()]));
  seedFile(f, groupPath(typeId), [0xff]);
  const controller = f.files();
  const store = storeFor(controller.service);
  const beforeLoad = parseStats.decodes;

  assert.equal(await store.load(), false);
  assert.equal(store.getSnapshot().loaded, false);
  assert.match(store.getSnapshot().error, /UTF-8|已损坏/);
  assert.equal(parseStats.decodes - beforeLoad, 1);
  const invalid = store.getSnapshot();

  assert.ok(await controller.service.create(`${directory}/unrelated.json`, [1], {createParents: false}));
  assert.strictEqual(store.getSnapshot(), invalid);
  assert.equal(parseStats.decodes - beforeLoad, 1, "the failed parse is cached for the same immutable bytes");

  assert.equal(await controller.service.delete(groupPath(typeId), {discardChanges: true}), true);
  assert.ok(await controller.service.create(groupPath(typeId), new TextEncoder().encode(JSON.stringify({assets: [], fields: []})),
    {createParents: false}));
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().loaded, true);
  assert.deepEqual(plain(store.getSnapshot().types), [type()]);
  assert.equal(parseStats.decodes - beforeLoad, 2, "a replacement byte array is parsed and validated once");

  store.dispose();
  await controller.dispose();
});
