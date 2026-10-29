import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../packages/ui/src/dialogGeometry.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports});
const centerDialogPosition = (...args) => ({...exports.centerDialogPosition(...args)});
const constrainDialogPosition = (...args) => ({...exports.constrainDialogPosition(...args)});

test("center keeps a fitting dialog centered inside the safety margin", () => {
  assert.deepEqual(centerDialogPosition({width: 200, height: 100}, {x: 0, y: 0, width: 800, height: 600}), {x: 300, y: 250});
});

test("constrain clamps a dialog against all four viewport edges", () => {
  const size = {width: 200, height: 120};
  const viewport = {x: 0, y: 0, width: 800, height: 600};
  assert.deepEqual(constrainDialogPosition({x: -80, y: -20}, size, viewport), {x: 16, y: 16});
  assert.deepEqual(constrainDialogPosition({x: 900, y: 800}, size, viewport), {x: 584, y: 464});
});

test("center and clamp honor a viewport offset", () => {
  const viewport = {x: 120, y: 70, width: 800, height: 600};
  const size = {width: 200, height: 100};
  assert.deepEqual(centerDialogPosition(size, viewport), {x: 420, y: 320});
  assert.deepEqual(constrainDialogPosition({x: -10, y: 900}, size, viewport), {x: 136, y: 554});
});

test("clamping after a dialog grows changes only the axis that no longer fits", () => {
  const viewport = {x: 10, y: 20, width: 800, height: 600};
  const position = {x: 500, y: 350};
  assert.deepEqual(constrainDialogPosition(position, {width: 700, height: 200}, viewport), {x: 94, y: 350});
});

test("safety margins shrink to half the viewport in narrow windows", () => {
  assert.deepEqual(constrainDialogPosition({x: -5, y: 0}, {width: 2, height: 2}, {x: 5, y: 9, width: 20, height: 12}), {x: 15, y: 15});
  assert.deepEqual(centerDialogPosition({width: 2, height: 2}, {x: 5, y: 9, width: 20, height: 12}), {x: 15, y: 15});
});

test("oversized dialogs anchor to the safe top-left instead of drifting outside", () => {
  const viewport = {x: 30, y: 40, width: 320, height: 240};
  const size = {width: 500, height: 400};
  assert.deepEqual(constrainDialogPosition({x: 90, y: 100}, size, viewport), {x: 46, y: 56});
  assert.deepEqual(centerDialogPosition(size, viewport), {x: 46, y: 56});
});
