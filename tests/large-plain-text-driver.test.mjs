import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/rich-text-editor/largePlainTextDriver.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports, require: createRequire(import.meta.url), console});

const {EditorSelection, EditorState} = createRequire(import.meta.url)("@codemirror/state");
const {redoDepth, undoDepth} = createRequire(import.meta.url)("@codemirror/commands");
const {createLargePlainTextState, replaceLargePlainTextState} = exports;

test("large plain text state normalizes line endings while retaining BOM and trailing newlines", () => {
  const state = createLargePlainTextState("\uFEFF第一行\r\n第二行\r第三行\n", false);

  assert.equal(state.doc.toString(), "\uFEFF第一行\n第二行\n第三行\n");
  assert.equal(state.doc.lines, 4, "a terminal newline remains represented as an empty final line");
});

test("readonly state rejects user edits but accepts programmatic document replacement", () => {
  const state = createLargePlainTextState("原文", true);
  const rejected = state.update({changes: {from: 2, insert: "用户输入"}, userEvent: "input.type"});

  assert.equal(rejected.docChanged, false);
  assert.equal(rejected.state.doc.toString(), "原文");

  const replaced = replaceLargePlainTextState(rejected.state, "外部替换\r\n内容");
  assert.equal(replaced.doc.toString(), "外部替换\n内容");
  assert.equal(replaced.facet(EditorState.readOnly), true);
});

test("external replacement clears undo and redo history and clamps the selection", () => {
  const initial = createLargePlainTextState("初始正文", false);
  const selected = initial.update({selection: EditorSelection.cursor(4)}).state;
  const edited = selected.update({changes: {from: 4, insert: "修改"}, userEvent: "input.type"}).state;
  const withUndo = edited.update({changes: {from: 0, insert: "前置"}, userEvent: "input.type"}).state;

  assert.ok(undoDepth(withUndo) > 0);
  const replaced = replaceLargePlainTextState(withUndo, "新");

  assert.equal(replaced.doc.toString(), "新");
  assert.equal(undoDepth(replaced), 0);
  assert.equal(redoDepth(replaced), 0);
  assert.equal(replaced.selection.main.anchor, 1);
});
