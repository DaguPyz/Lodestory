import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/plugins/canvas/createCanvasViewport.ts", import.meta.url), "utf8"), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;

function fixture() {
  const module = {exports: {}};
  const errors = [];
  vm.runInNewContext(compiled, {module, exports: module.exports, console: {error(...args) { errors.push(args); }}});
  return {create: module.exports.createCanvasViewport, errors};
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
const worldAt = (state, point, size) => ({
  x: state.center.x + (point.x - size.width / 2) / state.zoom,
  y: state.center.y + (point.y - size.height / 2) / state.zoom,
});

test("the world point under the mouse stays fixed through pan, zoom and zoom limits", () => {
  const viewport = fixture().create();
  viewport.panBy(-381, 127);
  const point = {x: 173, y: 691};
  const size = {width: 1440, height: 800};
  const world = worldAt(viewport.getSnapshot(), point, size);
  for (const zoom of [1.25, 0.5, 4, 100, 0.01, 2, 1]) {
    viewport.zoomTo(zoom, {point, size});
    const after = worldAt(viewport.getSnapshot(), point, size);
    near(after.x, world.x); near(after.y, world.y);
    assert.ok(viewport.getSnapshot().zoom >= 0.25 && viewport.getSnapshot().zoom <= 4);
  }
  viewport.zoomTo(4);
  const atLimit = viewport.getSnapshot();
  assert.equal(viewport.zoomTo(100, {point, size}), false);
  assert.strictEqual(viewport.getSnapshot(), atLimit, "continuing to zoom at the limit cannot move the world");
});

test("drag distances stay in screen pixels and zoom reset preserves the current world center", () => {
  const viewport = fixture().create();
  viewport.zoomTo(2);
  viewport.panBy(120, -80);
  assert.equal(viewport.getSnapshot().center.x, -60);
  assert.equal(viewport.getSnapshot().center.y, 40);
  viewport.resetZoom();
  assert.equal(viewport.getSnapshot().zoom, 1);
  assert.equal(viewport.getSnapshot().center.x, -60);
  assert.equal(viewport.getSnapshot().center.y, 40);
  viewport.resetView();
  assert.equal(viewport.getSnapshot().zoom, 1);
  assert.equal(viewport.getSnapshot().center.x, 0);
  assert.equal(viewport.getSnapshot().center.y, 0);
});

test("each viewport retains an independent immutable view and caller-owned points cannot edit it", () => {
  const {create} = fixture();
  const initial = {x: 20, y: -30};
  const first = create({center: initial});
  const second = create();
  initial.x = 1000;
  const before = first.getSnapshot();
  assert.equal(before.center.x, 20);
  assert.equal(Object.isFrozen(before.center), true);
  assert.throws(() => { before.center.y = 9; }, TypeError);
  first.panBy(50, 0);
  assert.equal(first.getSnapshot().center.x, -30);
  assert.equal(second.getSnapshot().center.x, 0);
  assert.strictEqual(second.getSnapshot(), second.getSnapshot());
});

test("invalid navigation cannot publish NaN or infinity or corrupt the current view", () => {
  const {create} = fixture();
  const viewport = create();
  const initial = viewport.getSnapshot();
  assert.equal(viewport.panBy(NaN, 10), false);
  assert.equal(viewport.panBy(10, Infinity), false);
  for (const value of [0, -1, NaN, Infinity]) assert.equal(viewport.zoomTo(value), false);
  assert.equal(viewport.zoomTo(2, {point: {x: 10, y: 20}, size: {width: NaN, height: 20}}), false);
  assert.strictEqual(viewport.getSnapshot(), initial);
  assert.throws(() => create({zoom: NaN}));
});

test("throwing observers cannot block other observers, and disposed viewports cannot be edited", () => {
  const {create, errors} = fixture();
  let released = 0;
  const viewport = create({}, () => { released++; });
  let notifications = 0;
  viewport.subscribe(() => { throw new Error("observer failed"); });
  const remove = viewport.subscribe(() => { notifications++; });
  viewport.panBy(20, 30);
  assert.equal(notifications, 1);
  assert.equal(errors.length, 1);
  remove(); remove();
  viewport.dispose(); viewport.dispose();
  const stopped = viewport.getSnapshot();
  assert.equal(stopped.disposed, true);
  assert.equal(released, 1);
  assert.equal(viewport.panBy(10, 10), false);
  assert.equal(viewport.zoomTo(2), false);
  assert.equal(viewport.resetView(), false);
  assert.strictEqual(viewport.getSnapshot(), stopped);
});

test("canvas plugin owns independent surfaces and releases outstanding viewports on stop", async () => {
  const f = createMainFixture();
  const plugin = f.loadModule("plugins/canvas/canvasPlugin.tsx").createCanvasPlugin();
  const key = f.requireSdk("@lodestory/sdk/canvas").canvasKey;
  let service;
  plugin.activate({provide(providedKey, value) { assert.strictEqual(providedKey, key); service = value; }});
  assert.equal(plugin.requires.length, 0, "the canvas provider does not depend on project or outline services");
  assert.equal(typeof service.Surface, "function");
  const first = service.createViewport();
  const second = service.createViewport();
  first.panBy(20, 0);
  assert.equal(second.getSnapshot().center.x, 0);
  first.dispose();
  await plugin.deactivate();
  assert.equal(second.getSnapshot().disposed, true);
  assert.equal(second.zoomTo(2), false);
  assert.throws(() => service.createViewport(), /no longer active/);
});
