import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const moduleRoot = new URL("../src/plugins/rich-text-editor/", import.meta.url);

function loadTypeScript(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, moduleRoot), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      return require(specifier);
    },
  });
  return module.exports;
}

function makeRegistryHarness() {
  class FakeStyleAttributor {
    constructor(attrName, keyName, options = {}) {
      this.attrName = attrName;
      this.keyName = keyName;
      this.scope = options.scope;
      this.whitelist = options.whitelist;
    }
    canAdd(_node, value) {
      return this.whitelist == null || this.whitelist.includes(value);
    }
    add(node, value) {
      if (!this.canAdd(node, value)) return false;
      node.style[this.keyName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
      return true;
    }
    value(node) {
      const value = node.style[this.keyName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
      return this.canAdd(node, value) ? value : "";
    }
  }
  class FakeRegistry {
    constructor() { this.definitions = []; }
    register(...definitions) {
      this.definitions.push(...definitions);
      return definitions;
    }
  }
  class ListContainer { static blotName = "list-container"; }
  class ListItem { static blotName = "list"; static requiredContainer = ListContainer; }

  const imported = new Map();
  for (const name of [
    "blots/scroll", "blots/block", "blots/break", "blots/cursor", "blots/inline",
    "blots/text", "blots/embed", "blots/block/embed", "blots/container", "formats/bold",
    "formats/italic", "formats/underline", "formats/strike", "formats/header",
    "formats/blockquote", "formats/link",
  ]) imported.set(name, class { static blotName = name; });
  imported.set("formats/list", ListItem);
  for (const [name, attrName, keyName] of [
    ["attributors/style/align", "align", "text-align"],
    ["attributors/style/color", "color", "color"],
    ["attributors/style/background", "background", "background-color"],
  ]) imported.set(name, new FakeStyleAttributor(attrName, keyName));

  const globalRegistrationCalls = [];
  const fakeQuill = {
    import(name) { return imported.get(name); },
    register(...args) { globalRegistrationCalls.push(args); },
  };
  const Scope = {INLINE: 1, BLOCK: 2};
  const Parchment = {Registry: FakeRegistry, StyleAttributor: FakeStyleAttributor, Scope};
  const richTextFormatting = loadTypeScript("richTextFormatting.ts");
  const richDeltaFormat = loadTypeScript("richDeltaFormat.ts", {
    "./richTextFormatting": richTextFormatting,
  });
  const quillModule = {__esModule: true, default: fakeQuill, Parchment};
  const {createRichTextRegistry} = loadTypeScript("quillRichTextRegistry.ts", {
    quill: quillModule,
    "./richDeltaFormat": richDeltaFormat,
    "./richTextFormatting": richTextFormatting,
  });
  return {createRichTextRegistry, globalRegistrationCalls, ListContainer, ListItem};
}

test("Quill registry is per editor and registers list container dependencies and requested formats", () => {
  const harness = makeRegistryHarness();
  const first = harness.createRichTextRegistry();
  const second = harness.createRichTextRegistry();

  assert.notStrictEqual(first, second);
  assert.ok(first.definitions.includes(harness.ListContainer));
  assert.ok(first.definitions.includes(harness.ListItem));
  assert.ok(second.definitions.includes(harness.ListContainer));
  assert.ok(second.definitions.includes(harness.ListItem));
  for (const registry of [first, second]) {
    for (const name of ["font", "size", "align", "color", "background"]) {
      assert.ok(registry.definitions.some(definition => definition.attrName === name), `${name} is registered`);
    }
  }
  assert.deepEqual(harness.globalRegistrationCalls, [], "the factory does not mutate Quill's global registry");
});

test("custom font attributor writes one escaped CSS family and reads its original name", () => {
  const {createRichTextRegistry} = makeRegistryHarness();
  const registry = createRichTextRegistry();
  const font = registry.definitions.find(definition => definition.attrName === "font");
  const families = ["中文 字体", "O'Brien", 'The "Quoted" Family', "Family, With Comma", "C:\\Fonts"];

  for (const family of families) {
    const node = {style: {fontFamily: ""}};
    assert.equal(font.add(node, family), true, family);
    assert.equal(font.value(node), family, family);
    assert.ok(node.style.fontFamily.startsWith('"'), "the CSS property is stored as a quoted family string");
  }
});

test("custom size attributor delegates its unrestricted range check without affecting other registries", () => {
  const {createRichTextRegistry} = makeRegistryHarness();
  const first = createRichTextRegistry();
  const second = createRichTextRegistry();
  const size = first.definitions.find(definition => definition.attrName === "size");
  const otherSize = second.definitions.find(definition => definition.attrName === "size");
  const node = {style: {fontSize: ""}};

  assert.notStrictEqual(size, otherSize);
  assert.equal(size.add(node, "256px"), true);
  assert.equal(size.value(node), "256px");
  assert.equal(size.add(node, "257px"), false);
  assert.ok(second.definitions.some(definition => definition.attrName === "align"));
  assert.ok(second.definitions.some(definition => definition.attrName === "color"));
});

function replaceGlobals(values) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: previous.get(name)?.enumerable ?? true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

async function loadRealQuillRegistry() {
  const restoreGlobals = replaceGlobals({
    window: {},
    document: {addEventListener() {}, removeEventListener() {}},
    Node: {ELEMENT_NODE: 1, TEXT_NODE: 3},
    navigator: {platform: ""},
  });
  let quillModule;
  try {
    quillModule = await import("quill");
  } finally {
    restoreGlobals();
  }

  const richTextFormatting = loadTypeScript("richTextFormatting.ts");
  const richDeltaFormat = loadTypeScript("richDeltaFormat.ts", {
    "./richTextFormatting": richTextFormatting,
  });
  const {createRichTextRegistry} = loadTypeScript("quillRichTextRegistry.ts", {
    // The VM runs CommonJS output, so expose the real ESM namespace as such.
    quill: {__esModule: true, ...quillModule},
    "./richDeltaFormat": richDeltaFormat,
    "./richTextFormatting": richTextFormatting,
  });
  return {createRichTextRegistry, quillModule};
}

test("the registry builds with real Quill and Parchment definitions, excluding abstract core blots", async () => {
  const {createRichTextRegistry, quillModule} = await loadRealQuillRegistry();
  const Quill = quillModule.default;
  const Parchment = quillModule.Parchment;
  const importsBefore = {...Quill.imports};
  const globalFont = importsBefore["formats/font"];
  const globalFontWhitelist = globalFont?.whitelist ? [...globalFont.whitelist] : undefined;
  assert.equal(Quill.import("blots/embed").blotName, "abstract");
  assert.equal(Quill.import("blots/block/embed").blotName, "abstract");
  assert.equal(Quill.import("blots/container").blotName, "container");

  const registry = createRichTextRegistry();

  for (const blotName of ["scroll", "block", "break", "cursor", "inline", "text", "list"]) {
    assert.ok(registry.query(blotName), "the real Parchment registry should resolve " + blotName);
  }
  const ListItem = Quill.import("formats/list");
  assert.ok(ListItem.requiredContainer, "Quill's list format declares its concrete required container");
  assert.strictEqual(registry.query(ListItem.requiredContainer.blotName), ListItem.requiredContainer);
  assert.strictEqual(registry.query(ListItem.blotName), ListItem);
  for (const formatName of ["font", "size", "align", "color", "background"]) {
    assert.ok(registry.query(formatName), "the real Parchment registry should resolve " + formatName);
  }
  assert.deepEqual(Object.keys(Quill.imports).sort(), Object.keys(importsBefore).sort());
  for (const [name, definition] of Object.entries(importsBefore)) {
    assert.strictEqual(Quill.imports[name], definition, "global Quill import remains unchanged: " + name);
  }
  assert.strictEqual(Quill.imports["formats/font"], globalFont, "the factory leaves the global font format unchanged");
  assert.deepEqual(globalFont?.whitelist ? [...globalFont.whitelist] : undefined, globalFontWhitelist);
  assert.equal(typeof Parchment.Registry, "function");
});
