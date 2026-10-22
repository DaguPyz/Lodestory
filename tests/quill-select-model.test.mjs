import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const plain = value => JSON.parse(JSON.stringify(value));

function loadModel() {
  const source = readFileSync(new URL("../src/plugins/rich-text-editor/quillSelectModel.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === "./richTextFormatting") {
        return {isRichFontFamily: value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)};
      }
      throw new Error(`Unexpected import ${specifier}`);
    },
  });
  return module.exports;
}

function createFakeQuill({selection = null, length = 30, enabled = true, formats = {}} = {}) {
  const listeners = new Map();
  const calls = {formats: [], selections: [], focus: 0};
  let currentSelection = selection;
  let isEnabled = enabled;
  const quill = {
    getSelection() { return currentSelection; },
    getLength() { return length; },
    getFormat() { return formats; },
    isEnabled() { return isEnabled; },
    setSelection(index, rangeLength, source) {
      calls.selections.push([index, rangeLength, source]);
      currentSelection = {index, length: rangeLength};
    },
    format(name, value, source) { calls.formats.push([name, value, source]); },
    focus() { calls.focus++; },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    off(event, listener) { listeners.get(event)?.delete(listener); },
    emit(...args) {
      for (const listener of [...(listeners.get("editor-change") ?? [])]) listener(...args);
    },
    setSelectionValue(value) { currentSelection = value; },
    setEnabled(value) { isEnabled = value; },
  };
  return {quill, calls, listeners};
}

test("system font options retain unusual names and an unavailable document font", () => {
  const {createSystemFontOptions} = loadModel();
  const options = createSystemFontOptions(
    ["Arial", "宋体", "Noto Sans CJK SC", "O'Brien", 'A"B', "Arial", "  "],
    'Missing "Family" (not installed)',
  );

  assert.deepEqual(plain(options.map(option => option.value)), [
    "", 'Missing "Family" (not installed)', "Arial", "宋体", "Noto Sans CJK SC", "O'Brien", 'A"B',
  ]);
  assert.equal(options[1].label, 'Missing "Family" (not installed)（文档字体）');
  assert.deepEqual(plain(createSystemFontOptions(["Arial"], "Arial").map(option => option.value)), ["", "Arial"]);
});

test("Quill picker values preserve default labels and expose real palette swatches", () => {
  const {createPickerOptions} = loadModel();

  assert.deepEqual(plain(createPickerOptions("header", ["1", "2", "3", ""]).map(option => option.label)), [
    "标题 1", "标题 2", "标题 3", "正文",
  ]);
  assert.deepEqual(plain(createPickerOptions("align", ["", "center", "right", "justify"]).map(option => option.label)), [
    "左对齐", "居中对齐", "右对齐", "两端对齐",
  ]);
  assert.deepEqual(plain(createPickerOptions("color", ["", "#e60000"])), [
    {value: "", label: "默认颜色"},
    {value: "#e60000", label: "#e60000", swatch: "#e60000"},
  ]);
  assert.deepEqual(plain(createPickerOptions("background", ["#ffffff"])), [
    {value: "#ffffff", label: "#ffffff", swatch: "#ffffff"},
  ]);
});

test("format controller restores the last Quill range and applies shared Select choices", () => {
  const {createQuillSelectController} = loadModel();
  const fake = createFakeQuill({selection: null, length: 20});
  let updates = 0;
  const controller = createQuillSelectController(fake.quill, () => { updates++; });

  fake.quill.emit("selection-change", {index: 4, length: 3}, null, "user");
  fake.quill.setSelectionValue(null);
  assert.deepEqual(plain(controller.getRange()), {index: 4, length: 3});
  assert.equal(controller.apply("header", "2"), false, "initially read-only controls cannot format");

  controller.setReadOnly(false);
  assert.equal(controller.apply("header", "2"), true);
  assert.deepEqual(fake.calls.selections, [[4, 3, "silent"]]);
  assert.deepEqual(fake.calls.formats, [["header", "2", "user"]]);
  assert.equal(fake.calls.focus, 1);
  assert.equal(updates >= 2, true, "selection and state changes refresh the rendered control");

  controller.destroy();
  assert.equal(fake.listeners.get("editor-change").size, 0);
  assert.equal(controller.apply("header", ""), false, "destroyed controls cannot act");
});

test("format controller clips stale and out-of-bounds Quill ranges", () => {
  const {createQuillSelectController} = loadModel();
  const fake = createFakeQuill({selection: {index: 99, length: 20}, length: 11});
  const controller = createQuillSelectController(fake.quill);

  assert.deepEqual(plain(controller.getRange()), {index: 10, length: 0}, "ranges past the document end clamp to the final editable index");
  fake.quill.setSelectionValue({index: -5, length: 8});
  assert.deepEqual(plain(controller.getRange()), {index: 0, length: 8}, "negative indices clamp to the start");
  fake.quill.setSelectionValue({index: 8, length: 40});
  assert.deepEqual(plain(controller.getRange()), {index: 8, length: 2}, "selection length cannot include Quill's terminal newline");
  fake.quill.setSelectionValue({index: 5, length: -4});
  assert.deepEqual(plain(controller.getRange()), {index: 5, length: 0}, "negative selection lengths clamp to zero");
  controller.destroy();
});

test("empty-string picker values select the Quill default and apply as false", () => {
  const {createQuillSelectController} = loadModel();
  const fake = createFakeQuill({formats: {header: false, align: ""}});
  const controller = createQuillSelectController(fake.quill);

  assert.equal(controller.getValue("header"), "");
  assert.equal(controller.getValue("align"), "");
  controller.setReadOnly(false);
  assert.equal(controller.apply("header", ""), true);
  assert.equal(controller.apply("align", ""), true);
  assert.deepEqual(plain(fake.calls.formats), [
    ["header", false, "user"],
    ["align", false, "user"],
  ]);
  controller.destroy();
});

test("mixed formatting has no selected value and read-only or disabled editors block changes", () => {
  const {createQuillSelectController} = loadModel();
  const fake = createFakeQuill({selection: {index: 3, length: 4}, formats: {font: ["Arial", "Georgia"]}});
  const controller = createQuillSelectController(fake.quill);

  assert.equal(controller.getValue("font"), null);
  assert.equal(controller.apply("font", "Arial"), false);
  controller.setReadOnly(false);
  fake.quill.setEnabled(false);
  assert.equal(controller.apply("font", "Arial"), false);
  assert.deepEqual(fake.calls.formats, []);
  assert.equal(fake.calls.focus, 0);
  controller.destroy();
});
