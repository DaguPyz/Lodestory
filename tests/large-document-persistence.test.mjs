import assert from "node:assert/strict";
import test from "node:test";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

const encoder = new TextEncoder();

test("large text edits round-trip through shared storage, leave checks, failed saves, and reopen", async () => {
  let failSave = false;
  const fixture = byteStorageFixture({onInvoke(command) {
    if (command === "save_project_file" && failSave) throw new Error("simulated write failure");
  }});
  const original = "\uFEFF" + "正文😀\r\n".repeat(100_000) + "\r\n";
  const initialBytes = Array.from(encoder.encode(original));
  fixture.disk.set("/book/large.txt", initialBytes);
  const {createDocumentFiles} = fixture.f.loadModule("plugins/documents/documentFiles.ts");
  const {createDocumentWorkspace} = fixture.f.loadModule("plugins/documents/createDocumentWorkspace.ts");
  let controller = fixture.files();
  let workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
  try {
    assert.equal(await workspace.service.open("large.txt"), true);
    let document = workspace.service.getSnapshot().documents[0];
    assert.equal(await workspace.service.save(document.id), true);
    assert.deepEqual(fixture.disk.get("/book/large.txt"), initialBytes, "initial load and no-edit save preserve original BOM/CRLF bytes");
    assert.equal(fixture.calls.filter(call => call.command === "save_project_file").length, 0);

    const editorText = document.content.replace(/\r\n?/g, "\n");
    const edited = editorText.slice(0, 1) + "新增中文" + editorText.slice(1);
    workspace.service.update(document.id, edited);
    assert.equal(workspace.service.getSnapshot().documents[0].content, edited);
    failSave = true;
    assert.equal(await workspace.service.save(document.id), false);
    assert.equal(workspace.service.getSnapshot().documents[0].content, edited, "a failed save retains the complete draft");
    assert.equal(workspace.service.getSnapshot().documents[0].saveState, "error");
    assert.equal(await controller.beginLeave(), false, "a failed save blocks leaving the project");
    controller.endLeave();
    failSave = false;
    assert.equal(await workspace.service.saveAll(), true);
    assert.deepEqual(fixture.disk.get("/book/large.txt"), Array.from(encoder.encode(edited)));
    assert.equal(await controller.beginLeave(), true);
    await workspace.dispose();
    await controller.dispose();

    controller = fixture.files();
    workspace = createDocumentWorkspace(createDocumentFiles(controller.service));
    assert.equal(await workspace.service.open("large.txt"), true);
    document = workspace.service.getSnapshot().documents[0];
    assert.equal(document.content, edited, "reopening reads the complete edited source");
    assert.ok(document.content.startsWith("\uFEFF新增中文"));
    assert.ok(document.content.endsWith("\n\n"));
  } finally {
    failSave = false;
    await workspace.dispose();
    await controller.dispose();
  }
});
