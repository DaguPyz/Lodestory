import assert from "node:assert/strict";
import test from "node:test";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

const encode = text => Array.from(new TextEncoder().encode(text));

test("renaming a folder preserves open documents and their latest editor contents", async () => {
  const fixture = byteStorageFixture();
  fixture.directories.add("/book/章节");
  fixture.disk.set("/book/章节/一.txt", encode("旧稿"));
  fixture.disk.set("/book/章节/二.md", encode("第二篇"));
  const controller = fixture.files();
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  const workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("章节/一.txt"), true);
    assert.equal(await workspace.service.open("章节/二.md"), true);
    const first = workspace.service.getSnapshot().documents.find(doc => doc.path === "章节/一.txt");
    const second = workspace.service.getSnapshot().documents.find(doc => doc.path === "章节/二.md");
    let editorContent = "尚未同步的编辑";
    workspace.service.registerContentReader(first.id, () => editorContent);
    assert.equal(workspace.service.update(second.id, "第二篇修改"), true);
    assert.equal(await workspace.service.renamePath("章节", "新章节"), true);
    const state = workspace.service.getSnapshot();
    assert.deepEqual(Array.from(state.documents, doc => doc.path), ["新章节/一.txt", "新章节/二.md"]);
    assert.equal(state.documents[0].content, "尚未同步的编辑");
    assert.equal(state.documents[1].content, "第二篇修改");
    assert.equal(state.documents.find(doc => doc.id === state.activeId).path, "新章节/二.md");
    assert.deepEqual(fixture.disk.get("/book/新章节/一.txt"), encode("尚未同步的编辑"));
    assert.deepEqual(fixture.disk.get("/book/新章节/二.md"), encode("第二篇修改"));
    assert.equal(fixture.disk.has("/book/章节/一.txt"), false);
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
