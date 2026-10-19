import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createHarness(initialWidth = 320, initialPreferredWidth = initialWidth) {
  const fixture = createMainFixture();
  const {createNavigationResizeController} = fixture.loadModule("plugins/default-layout/navigationResizeController.ts");
  const state = {effectiveWidth: initialWidth, minWidth: 200, maxWidth: 520};
  let preferredWidth = initialPreferredWidth;
  let snapshotReads = 0;
  const previews = [];
  const commits = [];
  const cancels = [];
  const resets = [];
  const dragging = [];
  const errors = [];
  const captures = new Set();
  const target = {
    setPointerCapture(id) { captures.add(id); },
    releasePointerCapture(id) { captures.delete(id); },
    hasPointerCapture(id) { return captures.has(id); },
  };
  const controller = createNavigationResizeController({
    target,
    getSnapshot: () => { snapshotReads++; return state; },
    previewWidth(width) {
      previews.push(width);
      state.effectiveWidth = width;
    },
    commitWidth() {
      preferredWidth = state.effectiveWidth;
      commits.push(preferredWidth);
    },
    cancelPreview() {
      cancels.push(preferredWidth);
      state.effectiveWidth = preferredWidth;
    },
    reset() {
      resets.push(true);
      preferredWidth = 320;
      state.effectiveWidth = preferredWidth;
    },
    onError(error) { errors.push(error); },
    onDraggingChange(value) { dragging.push(value); },
  });
  return {controller, state, target, captures, previews, commits, cancels, resets, dragging, errors, snapshotReads: () => snapshotReads};
}

function pointer({pointerId = 1, clientX = 100, button = 0, isPrimary = true} = {}) {
  return {pointerId, clientX, button, isPrimary, prevented: false, preventDefault() { this.prevented = true; }};
}

function keyboard(key, {shiftKey = false, altKey = false, ctrlKey = false, metaKey = false} = {}) {
  return {key, shiftKey, altKey, ctrlKey, metaKey, prevented: false, preventDefault() { this.prevented = true; }};
}

test("pointer drag previews live and commits exactly once on pointerup", () => {
  const h = createHarness();
  const down = pointer({clientX: 100});
  h.controller.pointerDown(down);
  assert.deepEqual(h.dragging, [true]);
  assert.equal(h.captures.has(1), true);

  h.controller.pointerMove(pointer({pointerId: 2, clientX: 180}));
  assert.deepEqual(h.previews, [], "a different pointer cannot resize this drag");
  h.controller.pointerMove(pointer({pointerId: 1, clientX: 145}));
  assert.deepEqual(h.previews, [365]);
  assert.deepEqual(h.commits, [], "previewing does not persist the width");

  h.controller.pointerUp(pointer({pointerId: 1, clientX: 145}));
  h.controller.pointerUp(pointer({pointerId: 1, clientX: 145}));
  assert.deepEqual(h.commits, [365]);
  assert.deepEqual(h.dragging, [true, false]);
  assert.equal(h.captures.has(1), false);
  assert.deepEqual(h.errors, []);
});

test("pointerup applies its final coordinate when no matching move event arrived", () => {
  const h = createHarness();
  h.controller.pointerDown(pointer({pointerId: 8, clientX: 100}));
  h.controller.pointerUp(pointer({pointerId: 8, clientX: 150}));

  assert.deepEqual(h.previews, [370]);
  assert.deepEqual(h.commits, [370]);
  assert.deepEqual(h.dragging, [true, false]);
});

test("pointerup without an effective width change does not overwrite a wider preference", () => {
  const h = createHarness(400, 480);
  h.controller.pointerDown(pointer({pointerId: 5, clientX: 120}));
  h.controller.pointerUp(pointer({pointerId: 5, clientX: 120}));

  assert.deepEqual(h.commits, [], "a narrow viewport's effective width is not saved as the user's preference");
  assert.deepEqual(h.cancels, [480]);
  assert.equal(h.state.effectiveWidth, 480);
  assert.deepEqual(h.dragging, [true, false]);
});

test("Escape cancels an active drag and restores its starting preference", () => {
  const h = createHarness(410);
  h.controller.pointerDown(pointer({pointerId: 7, clientX: 200}));
  h.controller.pointerMove(pointer({pointerId: 7, clientX: 260}));
  const escape = keyboard("Escape");
  h.controller.keyDown(escape);

  assert.equal(escape.prevented, true);
  assert.deepEqual(h.commits, []);
  assert.deepEqual(h.cancels, [410]);
  assert.equal(h.state.effectiveWidth, 410);
  assert.equal(h.captures.has(7), false);
  assert.deepEqual(h.dragging, [true, false]);
});

test("keyboard resizing clamps to bounds and uses the larger Shift step", () => {
  const h = createHarness(315);
  h.controller.keyDown(keyboard("ArrowRight"));
  h.controller.keyDown(keyboard("ArrowLeft", {shiftKey: true}));
  h.controller.keyDown(keyboard("Home"));
  assert.deepEqual(h.previews, [325, 275, 200]);
  assert.deepEqual(h.commits, [325, 275, 200]);
  h.controller.keyDown(keyboard("ArrowLeft"));
  assert.deepEqual(h.previews, [325, 275, 200], "a key at the minimum does not preview or persist an unchanged width");
  assert.deepEqual(h.commits, [325, 275, 200]);
  h.controller.keyDown(keyboard("End"));
  h.controller.keyDown(keyboard("ArrowRight", {shiftKey: true}));

  assert.deepEqual(h.previews, [325, 275, 200, 520]);
  assert.deepEqual(h.commits, [325, 275, 200, 520], "a key at the maximum does not commit an unchanged width");
});

test("double click resets the preferred width", () => {
  const h = createHarness(470);
  h.controller.doubleClick();

  assert.deepEqual(h.resets, [true]);
  assert.equal(h.state.effectiveWidth, 320);
  assert.deepEqual(h.commits, [], "reset is persisted by the model reset action");
});

test("pointer cancellation, lost capture, and dispose clean up an active drag once", () => {
  for (const finish of [
    controller => controller.pointerCancel(pointer({pointerId: 3})),
    controller => controller.lostPointerCapture(pointer({pointerId: 3})),
    controller => controller.cancel(),
    controller => controller.dispose(),
  ]) {
    const h = createHarness(360);
    h.controller.pointerDown(pointer({pointerId: 3, clientX: 80}));
    h.controller.pointerMove(pointer({pointerId: 3, clientX: 100}));
    finish(h.controller);
    h.controller.pointerCancel(pointer({pointerId: 3}));

    assert.deepEqual(h.commits, []);
    assert.deepEqual(h.cancels, [360]);
    assert.equal(h.state.effectiveWidth, 360);
    assert.equal(h.captures.has(3), false);
    assert.deepEqual(h.dragging, [true, false]);
  }
});

test("separate controllers keep pointer state and previews independent", () => {
  const first = createHarness(300);
  const second = createHarness(440);
  first.controller.pointerDown(pointer({pointerId: 11, clientX: 100}));
  first.controller.pointerMove(pointer({pointerId: 11, clientX: 130}));

  assert.equal(first.state.effectiveWidth, 330);
  assert.equal(second.state.effectiveWidth, 440);
  assert.deepEqual(first.dragging, [true]);
  assert.deepEqual(second.dragging, []);

  first.controller.pointerUp(pointer({pointerId: 11, clientX: 130}));
  assert.deepEqual(first.commits, [330]);
  assert.deepEqual(second.commits, []);
  second.controller.dispose();
});

test("disposed controller ignores later pointer input without reading its snapshot", () => {
  const h = createHarness();
  h.controller.dispose();
  const reads = h.snapshotReads();
  h.controller.pointerDown(pointer({pointerId: 17}));
  h.controller.pointerMove(pointer({pointerId: 17, clientX: 140}));

  assert.equal(h.snapshotReads(), reads);
  assert.deepEqual(h.previews, []);
  assert.deepEqual(h.commits, []);
  assert.deepEqual(h.dragging, []);
  assert.equal(h.captures.size, 0);
});
