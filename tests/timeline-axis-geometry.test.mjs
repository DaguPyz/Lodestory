import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/plugins/timeline/timelineAxisGeometry.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const module = {exports: {}};
vm.runInNewContext(compiled, {module, exports: module.exports, Math, Number, Object, String});
const {
  TIMELINE_AXIS_BASE_PIXEL_INTERVAL,
  formatTimelineAxisValue,
  getTimelineAxisGeometry,
  timelineMajorFactor,
  timelineValueAtWorldX,
  timelineWorldXForValue,
} = module.exports;
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be close to ${expected}`);
const settings = {origin: 12.5, step: 5, unit: "天"};

test("custom origin anchors x=0 and values grow to the right and shrink to the left", () => {
  assert.equal(timelineValueAtWorldX(0, settings), 12.5);
  assert.equal(timelineValueAtWorldX(TIMELINE_AXIS_BASE_PIXEL_INTERVAL, settings), 17.5);
  assert.equal(timelineValueAtWorldX(-TIMELINE_AXIS_BASE_PIXEL_INTERVAL, settings), 7.5);
  assert.equal(timelineWorldXForValue(17.5, settings), TIMELINE_AXIS_BASE_PIXEL_INTERVAL);
  assert.equal(timelineWorldXForValue(7.5, settings), -TIMELINE_AXIS_BASE_PIXEL_INTERVAL);
});

test("decimal increments and large custom origins retain useful precision", () => {
  const decimal = {origin: -2.375, step: 0.125, unit: "轮次"};
  near(timelineValueAtWorldX(80, decimal), -2.3125);
  near(timelineValueAtWorldX(-320, decimal), -2.625);
  const large = {origin: 999_999_999.999999, step: 0.000001, unit: "年"};
  near(timelineValueAtWorldX(160, large), 1_000_000_000, 2e-7);
  assert.equal(formatTimelineAxisValue(-0), "0");
  assert.equal(formatTimelineAxisValue(1e-14), "1e-14");
  const tiny = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom: 1, width: 800, height: 500,
    settings: {origin: 1e-14, step: 0.000001, unit: "天"}});
  assert.equal(tiny.ticks.find(tick => tick.origin)?.value, 1e-14);
  const largeGeometry = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom: 1, width: 800, height: 500, settings: large});
  near(largeGeometry.ticks.find(tick => tick.worldX === 320)?.value, 1_000_000_000.000001, 2e-7);
});

test("zoom changes displayed major density while keeping the world-to-value mapping fixed", () => {
  const zooms = [0.25, 0.5, 1, 2, 4];
  const factors = zooms.map(timelineMajorFactor);
  assert.ok(factors[0] > factors[2], "zooming out groups more base intervals into a labeled major tick");
  assert.ok(factors[4] < factors[2], "zooming in reveals finer labeled major ticks");

  const worldX = 160;
  const valueAtX = timelineValueAtWorldX(worldX, settings);
  for (const zoom of zooms) {
    const geometry = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom, width: 1200, height: 700, settings});
    assert.ok(geometry.ticks.length > 0 && geometry.ticks.length <= 256);
    const renderedAtWorldX = geometry.ticks.find(tick => Math.abs(tick.worldX - worldX) < 1e-8);
    if (renderedAtWorldX) near(renderedAtWorldX.value, valueAtX);
    const screenMajorSpacing = geometry.majorWorldSpacing * zoom;
    assert.ok(screenMajorSpacing >= 128 - 1e-8 && screenMajorSpacing < 256,
      `major tick spacing should remain readable at ${zoom}x, got ${screenMajorSpacing}px`);
  }
});

test("panning moves tick positions without changing the values attached to world coordinates", () => {
  const before = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom: 1, width: 800, height: 500, settings});
  const after = getTimelineAxisGeometry({center: {x: 320, y: -40}, zoom: 1, width: 800, height: 500, settings});
  const common = before.ticks.find(tick => tick.major && tick.worldX === 160);
  const shifted = after.ticks.find(tick => tick.major && tick.worldX === 160);
  assert.ok(common && shifted);
  assert.equal(shifted.x, common.x - 320);
  assert.equal(shifted.value, common.value);
  assert.equal(shifted.value, 17.5);
});

test("large pan coordinates do not round distinct tick values into duplicates", () => {
  const geometry = getTimelineAxisGeometry({center: {x: 1e15, y: 0}, zoom: 1, width: 800, height: 500,
    settings: {origin: 0, step: 5, unit: "天"}});
  const majorValues = geometry.ticks.filter(tick => tick.major).map(tick => tick.value);
  assert.ok(majorValues.length > 2);
  assert.ok(majorValues.every((value, index) => index === 0 || value > majorValues[index - 1]));
  for (const tick of geometry.ticks) near(tick.value, timelineValueAtWorldX(tick.worldX, {origin: 0, step: 5, unit: "天"}), 1e-3);
});

test("only visible ticks are generated and malformed dimensions cannot create unbounded DOM", () => {
  const normal = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom: 1, width: 960, height: 640, settings});
  assert.ok(normal.ticks.every(tick => Math.abs(tick.x) <= 480 + 1e-9));
  assert.ok(normal.ticks.filter(tick => tick.labelVisible).every(tick => {
    const screenX = tick.x + 480;
    const labelWidth = Math.max(String(tick.value).length * 8, tick.origin ? 56 : 0) + 16;
    return screenX >= labelWidth / 2 && 960 - screenX >= labelWidth / 2;
  }));
  const malformed = getTimelineAxisGeometry({center: {x: 0, y: 0}, zoom: 0.25, width: 1e12, height: 640, settings});
  assert.equal(malformed.ticks.length, 0);
});
