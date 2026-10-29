import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/project-search/highlightMatches.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exports = {};
vm.runInNewContext(code, {exports});
const parts = (text, query) => JSON.parse(JSON.stringify(exports.highlightMatches(text, query)));

test("highlights every matching occurrence while preserving original text", () => {
  assert.deepEqual(parts("青云门与青云山", "青云"), [
    {text: "青云", matched: true}, {text: "门与", matched: false}, {text: "青云", matched: true}, {text: "山", matched: false},
  ]);
  assert.deepEqual(parts("不匹配", "  "), [{text: "不匹配", matched: false}]);
  assert.deepEqual(parts("不匹配", "其他"), [{text: "不匹配", matched: false}]);
});

test("highlighting follows case folding and Unicode normalization used by search", () => {
  assert.deepEqual(parts("Ｃａｆé 和 Cafe\u0301", "CAFÉ"), [
    {text: "Ｃａｆé", matched: true}, {text: " 和 ", matched: false}, {text: "Cafe\u0301", matched: true},
  ]);
  assert.deepEqual(parts("aﬃb", "fi"), [
    {text: "a", matched: false}, {text: "ﬃ", matched: true}, {text: "b", matched: false},
  ]);
  assert.deepEqual(parts("前가后", "가"), [
    {text: "前", matched: false}, {text: "가", matched: true}, {text: "后", matched: false},
  ]);
});
