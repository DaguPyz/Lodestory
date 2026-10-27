import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

async function loadTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, require, console});
  return exports;
}

const modelModule = await loadTypeScript("../src/plugins/plain-text-editor/textModel.ts");
const historyModule = await loadTypeScript("../src/plugins/plain-text-editor/history.ts");
const {createPlainTextModel, normalizeInsertedText} = modelModule;
const {createPlainTextHistory} = historyModule;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function scanLines(text) {
  const lines = [];
  let from = 0;
  while (true) {
    let end = from;
    while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end++;
    const to = end;
    if (end < text.length) end += text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? 2 : 1;
    lines.push({from, to, toWithBreak: end, text: text.slice(from, to)});
    if (end === text.length) {
      if (to < end) lines.push({from: end, to: end, toWithBreak: end, text: ""});
      break;
    }
    from = end;
  }
  return lines;
}

function expectedLineAt(lines, offset) {
  let selected = lines.at(-1);
  for (const line of lines) {
    if (offset < line.toWithBreak) {
      selected = line;
      break;
    }
  }
  const number = lines.indexOf(selected);
  return {...selected, number, column: Math.max(0, Math.min(offset - selected.from, selected.to - selected.from))};
}

function assertLine(actual, expected) {
  assert.deepEqual(plain(actual), expected);
}

test("keeps BOM, mixed CRLF/CR/LF endings, and trailing empty lines verbatim", () => {
  const source = "\uFEFF首行\r\n第二行\r第三行\n第四行\n\n";
  const model = createPlainTextModel(source, {blockLineLimit: 16});

  assert.equal(model.getText(), source);
  assert.equal(model.length, source.length);
  assert.equal(model.lineCount, 6);
  assert.equal(model.lineSeparator, "\r\n");
  assert.deepEqual(Array.from({length: model.lineCount}, (_, i) => model.getLine(i).text),
    ["\uFEFF首行", "第二行", "第三行", "第四行", "", ""]);
  assert.equal(normalizeInsertedText("x\ny\r\nz\r", model.lineSeparator), "x\r\ny\r\nz\r\n");
});

test("maps raw UTF-16 offsets to lines and columns, including CRLF and surrogate pairs", () => {
  const model = createPlainTextModel("A\r\n😀B\nC");

  assertLine(model.lineAt(1), {number: 0, from: 0, to: 1, toWithBreak: 3, column: 1, text: "A"});
  assertLine(model.lineAt(2), {number: 0, from: 0, to: 1, toWithBreak: 3, column: 1, text: "A"});
  assertLine(model.lineAt(3), {number: 1, from: 3, to: 6, toWithBreak: 7, column: 0, text: "😀B"});
  assertLine(model.lineAt(4), {number: 1, from: 3, to: 6, toWithBreak: 7, column: 1, text: "😀B"});
  assert.equal(model.offsetAt(1, 2), 5);
  assert.equal(model.slice(3, 5), "😀");
});

test("edits across line blocks preserve separators and allow CR and LF to form or split CRLF", () => {
  const rows = Array.from({length: 40}, (_, index) => `row-${index}`);
  const source = rows.join("\r\n");
  const model = createPlainTextModel(source, {blockLineLimit: 16});
  const from = model.getLine(14).from + 2;
  const to = model.getLine(19).from + 3;
  const insert = "替换\n段落\r";
  const expected = source.slice(0, from) + insert + source.slice(to);
  model.replace(from, to, insert);
  assert.equal(model.getText(), expected);
  assert.equal(model.lineCount, scanLines(expected).length);
  for (const [index, line] of scanLines(expected).entries()) assert.equal(model.getLine(index).text, line.text);

  // The operation spans the first 16-line block and removes the text between CR and LF.
  const boundarySource = `A\r${"\n".repeat(20)}B`;
  const boundary = createPlainTextModel(boundarySource, {blockLineLimit: 16});
  const crAt = boundarySource.indexOf("\r");
  const lfBeforeB = boundarySource.lastIndexOf("\n");
  boundary.replace(crAt + 1, lfBeforeB, "");
  assert.equal(boundary.getText(), "A\r\nB");
  assert.equal(boundary.lineCount, 2);
  boundary.replace(crAt + 1, crAt + 1, "X\n");
  assert.equal(boundary.getText(), "A\rX\n\nB");
  assert.equal(boundary.lineCount, 4);
});

test("reparses neighboring blocks when an edit joins CR and LF across a boundary, with reversible history", () => {
  const sourceWithTrailingCR = `${"a\r".repeat(16)}X`;
  const insertLf = createPlainTextModel(sourceWithTrailingCR, {blockLineLimit: 16});
  const insertHistory = createPlainTextHistory(insertLf);
  const firstExpected = `${"a\r".repeat(15)}a\r\nX`;
  insertHistory.apply(32, 32, "\n");
  assert.equal(insertLf.getText(), firstExpected);
  assert.equal(insertLf.lineCount, scanLines(firstExpected).length);
  assert.equal(insertLf.lineCount, 17);
  insertHistory.undo();
  assert.equal(insertLf.getText(), sourceWithTrailingCR);
  assert.equal(insertLf.lineCount, 17);
  insertHistory.redo();
  assert.equal(insertLf.getText(), firstExpected);
  assert.equal(insertLf.lineCount, 17);

  const sourceWithTextAndLf = `${"a\r".repeat(16)}X\nY`;
  const removeX = createPlainTextModel(sourceWithTextAndLf, {blockLineLimit: 16});
  const deleteHistory = createPlainTextHistory(removeX);
  const secondExpected = `${"a\r".repeat(15)}a\r\nY`;
  deleteHistory.apply(32, 33, "");
  assert.equal(removeX.getText(), secondExpected);
  assert.equal(removeX.lineCount, scanLines(secondExpected).length);
  assert.equal(removeX.lineCount, 17);
  deleteHistory.undo();
  assert.equal(removeX.getText(), sourceWithTextAndLf);
  assert.equal(removeX.lineCount, 18);
  deleteHistory.redo();
  assert.equal(removeX.getText(), secondExpected);
  assert.equal(removeX.lineCount, 17);
});

test("surrogate pairs survive local edits and history restoration", () => {
  const model = createPlainTextModel("A😀B\r\n尾行");
  const history = createPlainTextHistory(model);
  const emoji = model.slice(1, 3);
  assert.equal(emoji, "😀");
  history.apply(3, 3, "x", {
    before: {anchor: 3, head: 3}, after: {anchor: 4, head: 4}, group: "typing",
  });
  assert.equal(model.getText(), "A😀xB\r\n尾行");
  history.undo();
  assert.equal(model.getText(), "A😀B\r\n尾行");
  history.redo();
  assert.equal(model.getText(), "A😀xB\r\n尾行");
});

test("groups typing and composition replacements while restoring selections on undo and redo", () => {
  const model = createPlainTextModel("ab");
  const history = createPlainTextHistory(model);
  history.apply(1, 1, "x", {
    before: {anchor: 1, head: 1}, after: {anchor: 2, head: 2}, group: "typing",
  });
  history.apply(2, 2, "y", {
    before: {anchor: 2, head: 2}, after: {anchor: 3, head: 3}, group: "typing",
  });
  assert.equal(history.undoDepth, 1);
  assert.equal(model.getText(), "axyb");
  assert.deepEqual(plain(history.peekUndo()), {from: 1, to: 3, insert: "", selection: {anchor: 1, head: 1}});
  assert.deepEqual(plain(history.undo()), {anchor: 1, head: 1});
  assert.equal(model.getText(), "ab");
  assert.deepEqual(plain(history.peekRedo()), {from: 1, to: 1, insert: "xy", selection: {anchor: 3, head: 3}});
  assert.deepEqual(plain(history.redo()), {anchor: 3, head: 3});
  assert.equal(model.getText(), "axyb");

  const ime = createPlainTextModel("!", {blockLineLimit: 16});
  const imeHistory = createPlainTextHistory(ime);
  imeHistory.apply(0, 0, "拼", {
    before: {anchor: 0, head: 0}, after: {anchor: 1, head: 1}, group: "composition",
  });
  imeHistory.apply(0, 1, "拼音", {
    before: {anchor: 1, head: 1}, after: {anchor: 2, head: 2}, group: "composition",
  });
  assert.equal(imeHistory.undoDepth, 1);
  assert.equal(ime.getText(), "拼音!");
  imeHistory.undo();
  assert.equal(ime.getText(), "!");
});

test("clear drops history and maxBytes prunes older reversible edits", () => {
  const model = createPlainTextModel("");
  const history = createPlainTextHistory(model, {maxBytes: 2});
  history.apply(0, 0, "x");
  history.apply(1, 1, "y");
  assert.equal(history.undoDepth, 1);
  assert.equal(history.retainedBytes, 2);
  history.undo();
  assert.equal(model.getText(), "x", "the older edit was trimmed and cannot be undone");

  history.apply(1, 1, "z");
  history.clear();
  assert.equal(history.undoDepth, 0);
  assert.equal(history.redoDepth, 0);
  assert.equal(history.peekUndo(), undefined);
  assert.equal(history.peekRedo(), undefined);
  assert.equal(history.undo(), undefined);
  assert.equal(history.redo(), undefined);
  assert.equal(model.getText(), "xz");
});

test("200 randomized edits match a naive string and full line-index implementation", () => {
  let seed = 0x6d2b79f5;
  function random(max) {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0;
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    return ((seed ^ (seed >>> 14)) >>> 0) % max;
  }

  let source = `\uFEFF${Array.from({length: 45}, (_, index) => `第${index}行`).join("\r\n")}\n`;
  const model = createPlainTextModel(source, {blockLineLimit: 16});
  const inserts = ["", "a", "中文", "\n", "\r", "\r\n", "🙂", "e\u0301", "\t", "X\rY\n"];

  for (let iteration = 0; iteration < 240; iteration++) {
    const from = random(source.length + 1);
    const to = from + random(source.length - from + 1);
    const insert = inserts[random(inserts.length)];
    const expected = source.slice(0, from) + insert + source.slice(to);
    model.replace(from, to, insert);
    source = expected;

    const lines = scanLines(source);
    assert.equal(model.length, source.length, `length after edit ${iteration}`);
    assert.equal(model.lineCount, lines.length, `line count after edit ${iteration}`);
    assert.equal(model.getText(), source, `source after edit ${iteration}`);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      assertLine(model.getLine(lineNumber), {number: lineNumber, ...lines[lineNumber], column: 0});
    }

    const offset = random(source.length + 1);
    assertLine(model.lineAt(offset), expectedLineAt(lines, offset));
    const sliceFrom = random(source.length + 1);
    const sliceTo = sliceFrom + random(source.length - sliceFrom + 1);
    assert.equal(model.slice(sliceFrom, sliceTo), source.slice(sliceFrom, sliceTo));
  }
});

test("1000 small random edits preserve a large 500-line source and its full line index", () => {
  let seed = 0x51f15e;
  function random(max) {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0;
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    return ((seed ^ (seed >>> 14)) >>> 0) % max;
  }

  let source = Array.from({length: 500}, (_, index) => `line-${index.toString().padStart(3, "0")}`).join("\r\n");
  const model = createPlainTextModel(source, {blockLineLimit: 16});
  const inserts = ["", "x", "中文", "\n", "\r", "\r\n", "🙂"];
  for (let iteration = 0; iteration < 1000; iteration++) {
    const from = random(source.length + 1);
    const to = Math.min(source.length, from + random(5));
    const insert = inserts[random(inserts.length)];
    source = source.slice(0, from) + insert + source.slice(to);
    model.replace(from, to, insert);
    const lines = scanLines(source);
    assert.equal(model.length, source.length, `length after edit ${iteration}`);
    assert.equal(model.lineCount, lines.length, `line count after edit ${iteration}`);
    assert.equal(model.getText(), source, `source after edit ${iteration}`);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      assertLine(model.getLine(lineNumber), {number: lineNumber, ...lines[lineNumber], column: 0});
    }
  }
});
