import assert from "node:assert/strict";
import test from "node:test";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

const encode = text => Array.from(new TextEncoder().encode(text));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test("renaming a folder preserves open documents and their latest editor contents", async () => {
  const fixture = byteStorageFixture();
  fixture.directories.add("/book/章节");
  fixture.disk.set("/book/章节/一.txt", encode("旧稿"));
  fixture.disk.set("/book/章节/二.md", encode("保留的旧格式文件"));
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("章节/一.txt"), true);
    assert.equal(await workspace.service.open("章节/二.md"), false);
    const first = workspace.service.getSnapshot().documents.find(doc => doc.path === "章节/一.txt");
    let editorContent = "尚未同步的编辑";
    workspace.service.registerContentReader(first.id, () => editorContent);
    assert.equal(await workspace.service.renamePath("章节", "新章节"), true);
    const state = workspace.service.getSnapshot();
    assert.deepEqual(Array.from(state.documents, doc => doc.path), ["新章节/一.txt"]);
    assert.equal(state.documents[0].content, "尚未同步的编辑");
    assert.equal(state.documents.find(doc => doc.id === state.activeId).path, "新章节/一.txt");
    assert.deepEqual(fixture.disk.get("/book/新章节/一.txt"), encode("尚未同步的编辑"));
    assert.deepEqual(fixture.disk.get("/book/新章节/二.md"), encode("保留的旧格式文件"));
    assert.equal(fixture.disk.has("/book/章节/一.txt"), false);
    assert.equal(fixture.disk.has("/book/章节/二.md"), false);
    editorContent = "改名后继续编辑";
    assert.equal(workspace.service.update(state.documents[0].id, editorContent), true);
    assert.equal(await workspace.service.save(state.documents[0].id), true);
    assert.deepEqual(fixture.disk.get("/book/新章节/一.txt"), encode("改名后继续编辑"));
  } finally {
    await workspace.dispose();
    await controller.dispose();
  }
});

test("a failed save prevents rename and retains the draft at its original path", async () => {
  let failSave = true;
  const fixture = byteStorageFixture({onInvoke(command) {
    if (failSave && command === "save_project_file") throw new Error("保存失败");
  }});
  fixture.disk.set("/book/草稿.txt", encode("原文"));
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("草稿.txt"), true);
    const id = workspace.service.getSnapshot().documents[0].id;
    assert.equal(workspace.service.update(id, "未保存的内容"), true);
    assert.equal(await workspace.service.renamePath("草稿.txt", "新稿.txt"), false);
    assert.equal(workspace.service.getSnapshot().documents[0].content, "未保存的内容");
    assert.equal(workspace.service.getSnapshot().documents[0].path, "草稿.txt");
    assert.deepEqual(fixture.disk.get("/book/草稿.txt"), encode("原文"));
    assert.equal(fixture.disk.has("/book/新稿.txt"), false);
    assert.equal(fixture.calls.some(call => call.command === "rename_project_path"), false);
  } finally {
    failSave = false;
    await workspace.dispose();
    await controller.dispose();
  }
});

test("a rejected file suffix change preserves editor input captured during metadata lookup", async () => {
  const listingStarted = deferred();
  const listingGate = deferred();
  let delayListing = true;
  const fixture = byteStorageFixture({onInvoke: async command => {
    if (command === "list_project_directory" && delayListing) {
      delayListing = false;
      listingStarted.resolve();
      await listingGate.promise;
    }
  }});
  fixture.disk.set("/book/草稿.txt", encode("旧稿"));
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("草稿.txt"), true);
    const document = workspace.service.getSnapshot().documents[0];
    let editorContent = "旧稿";
    workspace.service.registerContentReader(document.id, () => editorContent);

    const rename = workspace.service.renamePath("草稿.txt", "草稿.md");
    await listingStarted.promise;
    editorContent = "检查重命名时输入的新内容";
    assert.equal(workspace.service.update(document.id, editorContent), true);
    listingGate.resolve();

    assert.equal(await rename, false);
    assert.deepEqual(fixture.disk.get("/book/草稿.txt"), encode(editorContent));
    assert.equal(fixture.disk.has("/book/草稿.md"), false);
    assert.equal(fixture.calls.some(call => call.command === "rename_project_path"), false);
  } finally {
    listingGate.resolve();
    await workspace.dispose();
    await controller.dispose();
  }
});

test("old-format files cannot be opened or renamed and remain on disk", async () => {
  const fixture = byteStorageFixture();
  fixture.disk.set("/book/legacy.md", encode("保留的文件"));
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("legacy.md"), false);
    assert.equal(await workspace.service.renamePath("legacy.md", "legacy.txt"), false);
    assert.deepEqual(fixture.disk.get("/book/legacy.md"), encode("保留的文件"));
    assert.equal(fixture.disk.has("/book/legacy.txt"), false);
    assert.equal(fixture.calls.some(call => call.command === "rename_project_path"), false);
  } finally {
    await workspace.dispose();
    await controller.dispose();
  }
});

test("a missing source path is rejected before invoking native rename", async () => {
  const fixture = byteStorageFixture();
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.renamePath("missing.txt", "target.txt"), false);
    assert.equal(fixture.calls.some(call => call.command === "rename_project_path"), false);
    assert.equal(fixture.disk.has("/book/missing.txt"), false);
    assert.equal(fixture.disk.has("/book/target.txt"), false);
  } finally {
    await workspace.dispose();
    await controller.dispose();
  }
});
