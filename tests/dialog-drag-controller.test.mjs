import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../packages/ui/src/dialogDragController.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports});
const {createDialogDragController} = exports;

function createHarness(initial = {x: 100, y: 80}, constrain = point => point) {
  const state = {position: {...initial}};
  const captures = new Set();
  const writes = [];
  const dragging = [];
  const target = {
    setPointerCapture(pointerId) { captures.add(pointerId); },
    releasePointerCapture(pointerId) { captures.delete(pointerId); },
    hasPointerCapture(pointerId) { return captures.has(pointerId); },
  };
  const controller = createDialogDragController({
    target,
    getPosition: () => state.position,
    constrain,
    setPosition(position) { state.position = {...position}; writes.push({...position}); },
    onDraggingChange(value) { dragging.push(value); },
  });
  return {controller, state, captures, writes, dragging};
}

function pointer({pointerId = 1, clientX = 100, clientY = 80, button = 0, isPrimary = true} = {}) {
  return {pointerId, clientX, clientY, button, isPrimary, prevented: false, preventDefault() { this.prevented = true; }};
}

test("requires more than a three-pixel movement, then follows the pointer and releases capture", () => {
  const h = createHarness();
  h.controller.pointerDown(pointer());
  assert.equal(h.controller.isActive(), true, "pointerdown is active before the drag threshold");
  h.controller.pointerMove(pointer({clientX: 102, clientY: 82}));
  assert.deepEqual(h.writes, [], "a small pointer jitter does not move the dialog");
  assert.deepEqual(h.dragging, []);

  const move = pointer({clientX: 120, clientY: 95});
  h.controller.pointerMove(move);
  assert.equal(move.prevented, true);
  assert.deepEqual(h.state.position, {x: 120, y: 95});
  assert.deepEqual(h.dragging, [true]);

  h.controller.pointerUp(pointer({clientX: 120, clientY: 95}));
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.captures.has(1), false);
  assert.deepEqual(h.dragging, [true, false]);
});

test("applies the pointerup coordinate even when the last pointermove was not delivered", () => {
  const h = createHarness({x: 35, y: 42});
  h.controller.pointerDown(pointer({pointerId: 8, clientX: 20, clientY: 20}));
  h.controller.pointerUp(pointer({pointerId: 8, clientX: 60, clientY: 70}));

  assert.deepEqual(h.state.position, {x: 75, y: 92});
  assert.deepEqual(h.dragging, [true, false]);
  assert.equal(h.captures.has(8), false);
});

test("constrains every move from the original pointer origin without accumulating boundary drift", () => {
  const constrain = point => ({x: Math.max(0, Math.min(200, point.x)), y: Math.max(0, Math.min(160, point.y))});
  const h = createHarness({x: 100, y: 80}, constrain);
  h.controller.pointerDown(pointer({clientX: 100, clientY: 80}));
  h.controller.pointerMove(pointer({clientX: 600, clientY: 600}));
  assert.deepEqual(h.state.position, {x: 200, y: 160});
  h.controller.pointerMove(pointer({clientX: 110, clientY: 90}));
  assert.deepEqual(h.state.position, {x: 110, y: 90}, "moving back from the edge resumes from the drag origin");
  h.controller.pointerUp(pointer({clientX: 110, clientY: 90}));
});

test("cancel and pointercancel restore the starting point within current bounds", () => {
  let maxX = 500;
  const h = createHarness({x: 120, y: 90}, point => ({x: Math.max(0, Math.min(maxX, point.x)), y: Math.max(0, point.y)}));
  h.controller.pointerDown(pointer());
  h.controller.pointerMove(pointer({clientX: 140, clientY: 120}));
  maxX = 80;
  assert.equal(h.controller.cancel(), true);
  assert.deepEqual(h.state.position, {x: 80, y: 90}, "rollback is clamped after a viewport resize");
  assert.equal(h.controller.cancel(), false, "cancelling twice does not issue another update");
  assert.deepEqual(h.dragging, [true, false]);

  h.controller.pointerDown(pointer({pointerId: 4}));
  h.controller.pointerMove(pointer({pointerId: 4, clientX: 130, clientY: 100}));
  h.controller.pointerCancel(pointer({pointerId: 4}));
  assert.deepEqual(h.state.position, {x: 80, y: 90});
  assert.equal(h.captures.has(4), false);
  assert.deepEqual(h.dragging, [true, false, true, false]);
});

test("lost capture restores the starting point and ignores unrelated pointer ids", () => {
  const h = createHarness();
  h.controller.pointerDown(pointer({pointerId: 5}));
  h.controller.pointerMove(pointer({pointerId: 6, clientX: 150, clientY: 150}));
  assert.deepEqual(h.writes, []);
  h.controller.pointerMove(pointer({pointerId: 5, clientX: 125, clientY: 110}));
  h.controller.lostPointerCapture(pointer({pointerId: 9}));
  assert.equal(h.controller.isActive(), true, "another pointer cannot finish this drag");
  h.controller.lostPointerCapture(pointer({pointerId: 5}));
  assert.deepEqual(h.state.position, {x: 100, y: 80});
  assert.equal(h.controller.isActive(), false);
  assert.deepEqual(h.dragging, [true, false]);
});

test("ignores non-primary, non-left, and non-finite pointer input", () => {
  const h = createHarness();
  for (const input of [
    pointer({button: 2}), pointer({isPrimary: false}), pointer({clientX: Number.NaN}),
    pointer({clientY: Number.POSITIVE_INFINITY}), pointer({pointerId: Number.NaN}),
  ]) h.controller.pointerDown(input);
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.captures.size, 0);
  assert.deepEqual(h.writes, []);
});

test("capture failures leave the dialog stationary and ignore later pointer events", () => {
  const h = createHarness();
  const controller = createDialogDragController({
    target: {setPointerCapture() { throw new Error("capture unavailable"); }, releasePointerCapture() {}, hasPointerCapture() { return false; }},
    getPosition: () => h.state.position,
    constrain: point => point,
    setPosition(position) { h.state.position = {...position}; h.writes.push({...position}); },
    onDraggingChange(value) { h.dragging.push(value); },
  });
  controller.pointerDown(pointer());
  controller.pointerMove(pointer({clientX: 130, clientY: 120}));

  assert.equal(controller.isActive(), false);
  assert.deepEqual(h.state.position, {x: 100, y: 80});
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.dragging, []);
});

test("dispose releases active capture without moving or notifying unmounted consumers", () => {
  const h = createHarness();
  h.controller.pointerDown(pointer());
  h.controller.pointerMove(pointer({clientX: 140, clientY: 120}));
  h.controller.dispose();

  assert.equal(h.controller.isActive(), false);
  assert.equal(h.captures.has(1), false);
  assert.deepEqual(h.state.position, {x: 140, y: 120}, "dispose does not write a restored point after unmount");
  assert.deepEqual(h.dragging, [true], "dispose does not notify removed consumers");
  assert.deepEqual(h.writes, [{x: 140, y: 120}]);
  h.controller.pointerMove(pointer({clientX: 160, clientY: 130}));
  assert.deepEqual(h.writes, [{x: 140, y: 120}]);
});
