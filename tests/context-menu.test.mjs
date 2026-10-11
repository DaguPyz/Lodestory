import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function load(name) {
  const source = await readFile(new URL(`../src/plugins/context-menu/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

const { resolveMenu, findMenuAction } = await load("menuModel");
const { createMenuCoordinator } = await load("menuCoordinator");
const noop = () => {};

test("hidden actions and empty groups do not leave an empty or malformed menu", () => {
  const config = [
    { id: "leading", type: "separator" },
    { id: "hidden", label: "隐藏", visible: false, onSelect: noop },
    { id: "empty", type: "submenu", label: "空子菜单", items: [] },
    { id: "a", label: "A", onSelect: noop },
    { id: "gap1", type: "separator" },
    { id: "gap2", type: "separator" },
    { id: "group", type: "group", items: [{ id: "invisible", label: "隐藏", visible: false, onSelect: noop }] },
    { id: "b", label: "B", onSelect: noop },
    { id: "trailing", type: "separator" },
  ];
  assert.deepEqual(Array.from(resolveMenu(config, undefined), (item) => item.id), ["a", "gap1", "b"]);
});

test("configuration factories evaluate arbitrary contexts without mutating the caller's entries", () => {
  const item = { id: "rename", label: "重命名", disabled: (context) => context.locked, visible: (context) => context.show, onSelect: noop };
  const factory = (context) => [{ ...item, label: context.title }];
  assert.equal(resolveMenu(factory, { title: "自由对象", show: true, locked: true })[0].disabled, true);
  assert.equal(resolveMenu(factory, { title: "另一个对象", show: true, locked: false })[0].label, "另一个对象");
  assert.equal(resolveMenu(factory, { show: false }).length, 0);
  assert.equal(typeof item.disabled, "function");
});

test("execution lookup rechecks visibility and parent submenu permissions", () => {
  const config = (context) => [{ id: "sub", type: "submenu", label: "操作", disabled: context.locked,
    items: [{ id: "do", label: "执行", visible: context.exists, onSelect: noop }] }];
  const path = ["sub", "do"];
  assert.equal(findMenuAction(resolveMenu(config, { locked: false, exists: true }), path).onSelect, noop);
  assert.equal(findMenuAction(resolveMenu(config, { locked: true, exists: true }), path), undefined);
  assert.equal(findMenuAction(resolveMenu(config, { locked: false, exists: false }), path), undefined);
});

test("cleanup from the previous menu cannot release the newly opened menu", () => {
  const manager = createMenuCoordinator();
  const calls = [];
  manager.activate("one", (reason) => { calls.push(`one:${reason}`); manager.release("one"); });
  manager.activate("two", (reason) => calls.push(`two:${reason}`));
  manager.release("one");
  manager.closeAll();
  manager.closeAll();
  assert.deepEqual(calls, ["one:switch", "two:lifecycle"]);
});

test("one instance remains active on reopen and separate windows are isolated", () => {
  const first = createMenuCoordinator();
  const second = createMenuCoordinator();
  const calls = [];
  first.activate("same", (reason) => calls.push(`first:${reason}`));
  first.activate("same", () => calls.push("replacement"));
  second.activate("same", (reason) => calls.push(`second:${reason}`));
  first.closeAll("dismiss");
  second.closeAll("action");
  assert.deepEqual(calls, ["first:dismiss", "second:action"]);
});
