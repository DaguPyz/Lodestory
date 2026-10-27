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

const {createPlainTextModel} = await loadTypeScript("../src/plugins/plain-text-editor/textModel.ts");
const {TextLayout, nextTextBoundary, previousTextBoundary} = await loadTypeScript("../src/plugins/plain-text-editor/textLayout.ts");

function mockCanvas() {
  const context = {
    font: "",
    fontKerning: "auto",
    measureText(text) {
      if (text === "汉") return {width: 10};
      if (text === " ") return {width: 2};
      if (text === "e\u0301") return {width: 8};
      let width = 0;
      for (const char of text) width += char === "e" ? 8 : 10;
      return {width};
    },
  };
  return {getContext(type) { return type === "2d" ? context : null; }};
}

test("rowAt stays ordered while lazy line estimates resolve in both directions", () => {
  const source = "e\u0301\naaaaa\nx";
  const model = createPlainTextModel(source);
  const layout = new TextLayout(model, mockCanvas());
  layout.configure(15, "14px test");

  assert.equal(layout.rowCount, 7, "initial estimates count two rows for combining text and four for the long ASCII line");
  assert.deepEqual([layout.rowAt(0).line, layout.rowAt(0).start], [0, 0],
    "resolving the first line corrects its estimated count from two rows to one");
  assert.equal(layout.rowCount, 6);
  assert.deepEqual([layout.rowAt(1).line, layout.rowAt(1).start], [1, 0],
    "resolving the next line corrects its estimate from four rows to five");
  assert.equal(layout.rowCount, 7);

  const expected = [
    [0, 0, 2],
    [1, 0, 1], [1, 1, 2], [1, 2, 3], [1, 3, 4], [1, 4, 5],
    [2, 0, 1],
  ];
  const seen = new Set();
  for (let index = 0; index < expected.length; index++) {
    const row = layout.rowAt(index);
    const tuple = [row.line, row.start, row.end];
    assert.deepEqual(tuple, expected[index], `row ${index} maps to the matching source segment`);
    assert.equal(row.index, index, "the exposed visual index is monotonic and has no duplicate or skipped row");
    const identity = `${row.line}:${row.start}`;
    assert.equal(seen.has(identity), false, `row ${identity} is returned only once`);
    seen.add(identity);
  }

  assert.deepEqual([layout.rowForOffset(model.offsetAt(1, 4)).line,
    layout.rowForOffset(model.offsetAt(1, 4)).start], [1, 4],
  "offset lookup resolves and returns the final wrapped segment of a logical line");
});

test("movement boundaries keep combining accents and common emoji clusters intact", () => {
  const clusters = ["e\u0301", "👨‍👩‍👧‍👦", "🇨🇳", "👍🏽"];
  const text = clusters.join("");
  let offset = 0;
  for (const cluster of clusters) {
    assert.equal(nextTextBoundary(text, offset), offset + cluster.length,
      `${cluster} advances as one user-visible character`);
    offset += cluster.length;
    assert.equal(previousTextBoundary(text, offset), offset - cluster.length,
      `${cluster} deletes as one user-visible character`);
  }
  assert.equal(offset, text.length);
});

test("driver line ranges keep layout rows aligned across raw CRLF and block boundaries", () => {
  const model = createPlainTextModel(Array.from({length: 40}, (_, i) => `line-${i}`).join("\r\n"), {blockLineLimit: 16});
  const layout = new TextLayout(model, mockCanvas());
  layout.configure(1000, "14px test");

  function editLikeDriver(from, to, insert) {
    const first = model.lineAt(from).number;
    const last = model.lineAt(to).number;
    const beforeLines = model.lineCount;
    model.replace(from, to, insert);
    layout.update(first, last - first + 1, model.lineCount - beforeLines + last - first + 1);
  }

  function assertRowsMatchLines() {
    assert.equal(layout.rowCount, model.lineCount);
    for (let lineNumber = 0; lineNumber < model.lineCount; lineNumber++) {
      assert.equal(layout.rowAt(lineNumber).line, lineNumber);
      assert.equal(layout.rowForOffset(model.getLine(lineNumber).from).line, lineNumber);
    }
  }

  const acrossBlocks = model.getLine(14).from + 2;
  const throughSecondBlock = model.getLine(19).from + 3;
  editLikeDriver(acrossBlocks, throughSecondBlock, "替换\r\n新行\n");
  assertRowsMatchLines();

  const crlf = createPlainTextModel("A\r\nB");
  const crlfLayout = new TextLayout(crlf, mockCanvas());
  crlfLayout.configure(1000, "14px test");
  function editCrlf(from, to, insert) {
    const first = crlf.lineAt(from).number;
    const last = crlf.lineAt(to).number;
    const beforeLines = crlf.lineCount;
    crlf.replace(from, to, insert);
    crlfLayout.update(first, last - first + 1, crlf.lineCount - beforeLines + last - first + 1);
  }
  editCrlf(2, 2, "X"); // Insert between CR and LF.
  assert.equal(crlf.getText(), "A\rX\nB");
  assert.equal(crlfLayout.rowCount, crlf.lineCount);
  for (let lineNumber = 0; lineNumber < crlf.lineCount; lineNumber++) {
    assert.equal(crlfLayout.rowAt(lineNumber).line, lineNumber);
  }

  const joinAcrossBlocksSource = `A\r${"\n".repeat(20)}B`;
  const joined = createPlainTextModel(joinAcrossBlocksSource, {blockLineLimit: 16});
  const joinedLayout = new TextLayout(joined, mockCanvas());
  joinedLayout.configure(1000, "14px test");
  const from = 2;
  const to = joinAcrossBlocksSource.lastIndexOf("\n");
  const first = joined.lineAt(from).number;
  const last = joined.lineAt(to).number;
  const beforeLines = joined.lineCount;
  joined.replace(from, to, ""); // The surviving LF joins the earlier CR into CRLF.
  joinedLayout.update(first, last - first + 1, joined.lineCount - beforeLines + last - first + 1);
  assert.equal(joined.getText(), "A\r\nB");
  assert.equal(joinedLayout.rowCount, joined.lineCount);
  for (let lineNumber = 0; lineNumber < joined.lineCount; lineNumber++) {
    assert.equal(joinedLayout.rowAt(lineNumber).line, lineNumber);
  }
});
