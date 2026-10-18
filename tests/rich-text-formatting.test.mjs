import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/plugins/rich-text-editor/richTextFormatting.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const module = {exports: {}};
vm.runInNewContext(compiled, {exports: module.exports, module, require});
const {isRichFontFamily, parseFontFamily, quoteFontFamily} = module.exports;

test("font family validation accepts Unicode names and CSS-looking text as data", () => {
  for (const family of ["Arial", "Noto Sans CJK SC", "宋体", "O'Brien", 'The "Quoted" Family', "A, B", `x); color: red; }`]) {
    assert.equal(isRichFontFamily(family), true, family);
  }
});

test("font family validation rejects blank, overlong, and control-containing values", () => {
  for (const family of ["", " \t ", "x".repeat(1025), "Font\nFamily", "Font\u0085Family"]) {
    assert.equal(isRichFontFamily(family), false);
  }
  assert.equal(isRichFontFamily(undefined), false);
  assert.equal(isRichFontFamily(42), false);
});

test("font family CSS serialization safely round-trips punctuation and injection-looking names", () => {
  const family = `Font \\ "quoted"; color: red; } , (中文)`;
  const css = quoteFontFamily(family);
  assert.equal(css[0], '"');
  assert.equal(css.at(-1), '"');
  assert.equal(parseFontFamily(css), family);
});

test("font family parser decodes CSS escapes and accepts one unquoted family", () => {
  assert.equal(parseFontFamily('"Noto Sans"'), "Noto Sans");
  assert.equal(parseFontFamily("Noto Sans"), "Noto Sans");
  assert.equal(parseFontFamily('"Name\\22 With Quote"'), 'Name"With Quote');
  assert.equal(parseFontFamily('"Name\\5c With Slash"'), "Name\\With Slash");
});

test("font family parser rejects lists, malformed strings, and trailing CSS tokens", () => {
  for (const css of ["Arial, sans-serif", '"Arial", "Noto Sans"', '"unfinished', '"Arial"; color: red', "Arial\\"]) {
    assert.equal(parseFontFamily(css), undefined, css);
  }
});
