import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import {byteStorageFixture} from "./helpers/byteStorageFixture.mjs";

const compiled = ts.transpileModule(await readFile(new URL("../src/plugins/rich-text-editor/largePlainTextDriver.ts", import.meta.url), "utf8"), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const editor = {};
vm.runInNewContext(compiled, {exports: editor, require: createRequire(import.meta.url), console});
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
    let model = editor.createLargePlainTextState(document.content, false);
    assert.equal(await workspace.service.save(document.id), true);
    assert.deepEqual(fixture.disk.get("/book/large.txt"), initialBytes, "initial load and no-edit save preserve original BOM/CRLF bytes");
    assert.equal(fixture.calls.filter(call => call.command === "save_project_file").length, 0);

    model = model.update({changes: {from: 1, insert: "新增中文"}, userEvent: "input.type"}).state;
    const edited = model.doc.toString();
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
