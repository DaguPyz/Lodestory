import assert from "node:assert/strict";
import test from "node:test";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";
import {deferred, flushStartup} from "./helpers/mainStartupFixture.mjs";

const path = ".lodestory/asset-relations/relations.json";
const project = {id: "book", name: "故事", path: "/book"};
const teacher = "20000000-0000-4000-8000-000000000001";
const student = "20000000-0000-4000-8000-000000000002";
const other = "20000000-0000-4000-8000-000000000003";
const teacherSide = {assetsId: teacher, tag: "师父"};
const studentSide = {assetsId: student, tag: "徒弟"};
const mentorship = {assets: [teacherSide, studentSide], label: "萧炎拜药老为师"};
const copy = value => JSON.parse(JSON.stringify(value));

function relationsFixture(options) {
  const fixture = byteStorageFixture(options);
  const {createAssetRelationStore} = fixture.f.loadModule("plugins/asset-relations/assetRelationStore.ts");
  const files = fixture.files(project.path).service;
  const assets = [teacher, student, other].map(id => ({id}));
  const catalog = {getSnapshot: () => ({loaded: true, blocked: false, assets})};
  return {...fixture, assets, files, createStore: () => createAssetRelationStore(files, catalog),
    readFile: () => JSON.parse(Buffer.from(fixture.disk.get(fixture.key(project.path, path))).toString("utf8"))};
}

test("one relation is queried from either endpoint and reversing the pair keeps each tag with its asset", async () => {
  const {disk, createStore, readFile, assets} = relationsFixture();
  const store = createStore();
  assert.equal(await store.load(), true);
  assert.equal(disk.size, 0, "an empty project only gets a relation file on the first save");
  assert.equal(await store.save({assets: [studentSide, teacherSide], label: mentorship.label}), true);
  assert.equal(store.getRelations(student)[0], store.getRelations(teacher)[0]);
  assert.deepEqual(readFile().relations, [mentorship]);

  assert.equal(await store.save(mentorship), false, "reversing the endpoints cannot create a duplicate");
  const friendship = {assets: [{assetsId: student}, {assetsId: teacher, tag: "  "}], label: "朋友"};
  assert.equal(await store.save(friendship), true, "the same pair can have a second distinct relationship");
  assert.deepEqual(readFile().relations[1], {assets: [{assetsId: teacher}, {assetsId: student}], label: "朋友"});
  store.dispose();

  assets.shift();
  const reopened = createStore();
  assert.equal(await reopened.load(), true);
  assert.deepEqual(copy(reopened.getRelations(student)[0]), mentorship, "a missing asset does not erase a saved relation");
  const replacement = {assets: [studentSide, {assetsId: other}], label: "师徒"};
  assert.equal(await reopened.save(replacement, mentorship), true);
  assert.deepEqual(copy(reopened.getRelations(other)), [replacement]);
  assert.equal(await reopened.remove(replacement), true);
  assert.deepEqual(readFile().relations.map(relation => relation.label), ["朋友"]);
  reopened.dispose();
});

test("a first create with a lost response can retry without adding a duplicate and excludes concurrent mutations", async () => {
  const started = deferred();
  const proceed = deferred();
  let firstCreate = true;
  const {createStore, readFile, disk, key} = relationsFixture({async onInvoke(command, args) {
    if (command !== "create_project_file" || args.path !== path || !firstCreate) return;
    firstCreate = false;
    started.resolve();
    await proceed.promise;
    disk.set(key(project.path, path), args.bytes);
    throw new Error("保存响应中断");
  }});
  const store = createStore();
  assert.equal(await store.load(), true);
  const saving = store.save(mentorship);
  await started.promise;
  assert.equal(await store.save({assets: [teacherSide, studentSide], label: "朋友"}), false);
  proceed.resolve();
  assert.equal(await saving, false);
  assert.equal(store.getSnapshot().pending, true);
  assert.equal(store.getRelations(teacher).length, 0);
  assert.equal(await store.retrySave(), true);
  assert.equal(store.getSnapshot().pending, false);
  assert.deepEqual(readFile().relations, [mentorship]);
  store.dispose();
});

test("the project keeps a damaged relation file, and the optional panel can be withdrawn without withdrawing asset management", async () => {
  const {f, disk, directories, key} = byteStorageFixture();
  const fileKey = key(project.path, path);
  const damaged = [...Buffer.from("{damaged")];
  disk.set(fileKey, damaged);
  directories.add(key(project.path, ".lodestory"));
  directories.add(key(project.path, ".lodestory/asset-relations"));
  f.start();
  await flushStartup();
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const editor = f.getService(f.requireSdk("@lodestory/sdk/asset-editor").assetEditorKey);
  const relations = f.getService(f.requireSdk("@lodestory/sdk/asset-relations").assetRelationsKey);
  const catalog = f.getService(f.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey);
  const core = f.createdCores.at(-1);

  assert.deepEqual(Array.from(editor.getPanels(), panel => panel.id), ["asset-relations.panel"]);
  assert.equal(await workbench.openProject(project), true);
  for (let attempt = 0; attempt < 100 && workbench.getSnapshot().busy; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const {session, busy} = workbench.getSnapshot();
  assert.equal(busy, false);
  const network = relations.getNetwork(session.id);
  assert.equal(network.getSnapshot().loaded, false);
  assert.match(network.getSnapshot().error, /原文件已保留/);
  await core.unmount("asset-relations");
  assert.equal(editor.getPanels().length, 0);
  assert.equal(relations.getNetwork(session.id), null);
  assert.equal(catalog.getCatalog(session.id).getSnapshot().loaded, true);
  assert.deepEqual(disk.get(fileKey), damaged);
  assert.equal(await workbench.closeProject(), true);
  await core.unmountAll();
});
