import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/projects/projectDisplay.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const display = {};
vm.runInNewContext(compiled, { exports: display, Date }, { filename: "projectDisplay.js" });

test("UTC timestamps display as local calendar days and times", () => {
  const now = new Date(2026, 8, 29, 18, 0);
  const today = new Date(2026, 8, 29, 9, 41).toISOString();
  const yesterday = new Date(2026, 8, 28, 20, 16).toISOString();
  assert.equal(display.formatLastOpened(today, now), "今天 09:41");
  assert.equal(display.formatLastOpened(yesterday, now), "昨天 20:16");
  assert.equal(display.formatLastOpened(new Date(2026, 8, 25).toISOString(), now), "9月25日");
});

test("yesterday crosses month and year boundaries and older years are explicit", () => {
  const now = new Date(2026, 0, 1, 10, 0);
  assert.equal(display.formatLastOpened(new Date(2025, 11, 31, 23, 5).toISOString(), now), "昨天 23:05");
  assert.equal(display.formatLastOpened(new Date(2025, 11, 30).toISOString(), now), "2025年12月30日");
  assert.equal(display.formatLastOpened("invalid", now), "时间未知");
});

test("path truncation preserves the final directory on all desktop platforms", () => {
  for (const path of ["/Users/writer/Novels/长夜行舟", "C:\\Users\\writer\\Novels\\长夜行舟", "\\\\server\\Novels\\长夜行舟"]) {
    const separator = display.projectPathSeparator(path);
    assert.equal(path.slice(separator + 1), "长夜行舟");
  }
  assert.equal(display.projectPathSeparator("故事"), -1);
});
