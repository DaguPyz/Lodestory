import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.parentElement = undefined;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.removed = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  prepend(...children) {
    for (const child of children) child.parentElement = this;
    this.children.unshift(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = undefined;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({type, target: this});
    }
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    const siblings = this.parentElement?.children;
    if (siblings) {
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.parentElement = undefined;
  }
}

class FakeOption {
  constructor(label, value) {
    this.label = label;
    this.text = label;
    this.value = value;
  }
}

function loadSystemFontSelect() {
  const document = {createElement: tagName => new FakeElement(tagName)};
  const cache = new Map();

  function load(relativePath) {
    if (cache.has(relativePath)) return cache.get(relativePath).exports;
    const source = readFileSync(new URL("../src/plugins/rich-text-editor/" + relativePath, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    }).outputText;
    const module = {exports: {}};
    cache.set(relativePath, module);
    vm.runInNewContext(compiled, {
      exports: module.exports,
      module,
      document,
      Option: FakeOption,
      require(specifier) {
        if (specifier === "./richTextFormatting") return load("richTextFormatting.ts");
        throw new Error("Unexpected import '" + specifier + "' from '" + relativePath + "'.");
      },
    });
    return module.exports;
  }

  return {createSystemFontSelect: load("quillSystemFontSelect.ts").createSystemFontSelect, document};
}

function createFakeQuill({font, selection = null, length = 30, enabled = true} = {}) {
  const listeners = new Map();
  const calls = {formats: [], selections: [], focus: 0, getFormats: []};
  let currentFont = font;
  let currentSelection = selection;
  let isEnabled = enabled;
  const quill = {
    getSelection() { return currentSelection; },
    getLength() { return length; },
    getFormat(range) {
      calls.getFormats.push(range);
      return currentFont === undefined ? {} : {font: currentFont};
    },
    isEnabled() { return isEnabled; },
    setSelection(index, rangeLength, source) {
      calls.selections.push([index, rangeLength, source]);
      currentSelection = {index, length: rangeLength};
    },
    format(name, value, source) {
      calls.formats.push([name, value, source]);
      if (name === "font") currentFont = value || undefined;
    },
    focus() { calls.focus++; },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    off(event, listener) { listeners.get(event)?.delete(listener); },
    emitEditorChange(...args) {
      for (const listener of [...(listeners.get("editor-change") ?? [])]) listener(...args);
    },
  };

  return {
    quill,
    calls,
    listeners,
    setSelection(value) { currentSelection = value; },
    setFont(value) { currentFont = value; },
    setEnabled(value) { isEnabled = value; },
  };
}

test("the native select preserves the complete system font list, including unusual family names", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const {quill} = createFakeQuill({font: 'Existing "文档字体"'});
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(quill, toolbar);
  const families = ["Arial", "宋体", "Noto Sans CJK SC", "O'Brien", 'A"B', "Family, (Subset)", "Arial"];

  editor.setFamilies(families);

  const [group] = toolbar.children;
  const select = group.children.find(child => child.tagName === "SELECT");
  assert.equal(group.className, "ql-formats rich-text-font-family");
  assert.equal(select.attributes.get("aria-label"), "字体");
  assert.deepEqual(select.children.map(option => option.value), [
    "", 'Existing "文档字体"', "Arial", "宋体", "Noto Sans CJK SC", "O'Brien", 'A"B', "Family, (Subset)",
  ]);
  assert.equal(select.children[1].label, 'Existing "文档字体"（文档字体）');
  assert.equal(select.value, 'Existing "文档字体"');
  assert.equal(select.disabled, true, "the native selector remains disabled until editing is enabled");
});

test("the selector restores a remembered range after editor focus is lost and applies the chosen font", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const fake = createFakeQuill({selection: null});
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(fake.quill, toolbar);
  const select = toolbar.children[0].children.find(child => child.tagName === "SELECT");
  editor.setFamilies(["O'Brien", "宋体"]);
  editor.setReadOnly(false);
  fake.quill.emitEditorChange("selection-change", {index: 4, length: 3}, null, "user");

  fake.setSelection(null);
  select.value = "O'Brien";
  select.dispatch("change");

  assert.deepEqual(fake.calls.selections, [[4, 3, "silent"]]);
  assert.deepEqual(fake.calls.formats, [["font", "O'Brien", "user"]]);
  assert.equal(fake.calls.focus, 1);
  editor.destroy();
});

test("silent editor changes sync the current document font and preserve a font absent from the system list", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const fake = createFakeQuill({font: "Installed Family"});
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(fake.quill, toolbar);
  const select = toolbar.children[0].children.find(child => child.tagName === "SELECT");
  editor.setFamilies(["Installed Family", "另一种字体"]);
  editor.setReadOnly(false);
  assert.equal(select.value, "Installed Family");

  const unavailable = 'Missing "Family" (not installed)';
  fake.setFont(unavailable);
  fake.quill.emitEditorChange("text-change", {ops: []}, {ops: []}, "silent");

  assert.equal(select.value, unavailable);
  assert.deepEqual(select.children.map(option => option.value), ["", unavailable, "Installed Family", "另一种字体"]);
  assert.equal(select.children[1].label, unavailable + "（文档字体）");
  editor.destroy();
});

test("read-only mode and an empty system font list disable changes", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const fake = createFakeQuill();
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(fake.quill, toolbar);
  const select = toolbar.children[0].children.find(child => child.tagName === "SELECT");

  assert.equal(select.disabled, true, "empty list starts disabled");
  editor.setReadOnly(false);
  assert.equal(select.disabled, true, "empty list stays disabled even in editable mode");
  editor.setFamilies(["Arial"]);
  assert.equal(select.disabled, false);
  editor.setReadOnly(true);
  select.value = "Arial";
  select.dispatch("change");
  assert.equal(select.disabled, true);
  assert.deepEqual(fake.calls.selections, []);
  assert.deepEqual(fake.calls.formats, []);
  assert.equal(fake.calls.focus, 0);
  editor.destroy();
});

test("pointer focus can stay on an unchanged font without hiding subsequent keyboard focus", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const {quill, calls} = createFakeQuill();
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(quill, toolbar);
  const select = toolbar.children[0].children.find(child => child.tagName === "SELECT");
  editor.setFamilies(["Arial"]);
  editor.setReadOnly(false);

  select.dispatch("pointerdown");
  assert.equal(select.attributes.get("data-pointer-focus"), "true");
  assert.equal(select.value, "", "choosing the current default needs no change event");
  assert.deepEqual(calls.formats, [], "focus feedback must not change document formatting");
  select.dispatch("keydown");
  assert.equal(select.attributes.get("data-pointer-focus"), "false");
  select.dispatch("pointerdown");
  select.dispatch("blur");
  assert.equal(select.attributes.get("data-pointer-focus"), "false", "Tab can show focus after leaving the select");
  editor.destroy();
});

test("destroy removes the select and Quill listeners and makes repeated cleanup harmless", () => {
  const {createSystemFontSelect} = loadSystemFontSelect();
  const fake = createFakeQuill();
  const toolbar = new FakeElement("div");
  const editor = createSystemFontSelect(fake.quill, toolbar);
  const group = toolbar.children[0];
  const select = group.children.find(child => child.tagName === "SELECT");
  editor.setFamilies(["Arial"]);
  editor.setReadOnly(false);
  const readsBeforeDestroy = fake.calls.getFormats.length;

  editor.destroy();
  editor.destroy();
  select.value = "Arial";
  select.dispatch("change");
  fake.quill.emitEditorChange("text-change", {ops: []}, {ops: []}, "silent");

  assert.equal(toolbar.children.length, 0);
  assert.equal(group.removed, true);
  for (const event of ["change", "pointerdown", "keydown", "blur"]) {
    assert.equal(select.listeners.get(event).size, 0, `${event} listeners are removed`);
  }
  assert.equal(fake.listeners.get("editor-change").size, 0);
  assert.equal(fake.calls.getFormats.length, readsBeforeDestroy, "events after cleanup cannot read editor state");
  assert.deepEqual(fake.calls.formats, []);
  assert.deepEqual(fake.calls.selections, []);
});
