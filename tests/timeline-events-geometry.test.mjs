import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const axisSource = readFileSync(new URL("../src/plugins/timeline/timelineAxisGeometry.ts", import.meta.url), "utf8");
const compiledAxis = ts.transpileModule(axisSource, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const axisModule = {exports: {}};
vm.runInNewContext(compiledAxis, {module: axisModule, exports: axisModule.exports, Math, Number, Object, String});
const {getTimelineAxisGeometry} = axisModule.exports;
const source = readFileSync(new URL("../src/plugins/timeline/timelineEventsGeometry.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const module = {exports: {}};
vm.runInNewContext(compiled, {module, exports: module.exports, Math, Number, Object, String, Set});
const {getTimelineEventsGeometry} = module.exports;

function event(id, offset, patch = {}) {
  return {id, title: `事件${id}`, summary: "简短说明", offset, placement: "above", important: false, ...patch};
}

function geometry(events, patch = {}) {
  return getTimelineEventsGeometry({events, origin: 100, step: 5, center: {x: 0, y: 0}, zoom: 1,
    width: 1200, height: 720, ...patch});
}

function layoutAgainstAxis(events, {settings = {origin: 1994, step: 5, unit: "年"}, ...patch} = {}) {
  const input = {center: {x: 0, y: 0}, zoom: 1, width: 1200, height: 720, ...patch};
  const axis = getTimelineAxisGeometry({...input, settings});
  const eventLayout = getTimelineEventsGeometry({events, origin: settings.origin, step: settings.step,
    ...input, axisLabelBounds: axis.labelBounds});
  return {axis, eventLayout};
}

function rectanglesOverlap(left, right, gap = 0) {
  return left.left < right.left + right.width + gap && left.left + left.width + gap > right.left
    && left.top < right.top + right.height + gap && left.top + left.height + gap > right.top;
}

function assertCaptionAvoidsAxisAndStem(point, axisBounds) {
  assert.ok(point.turningCaption, `important event ${point.id} should have a visible turning caption`);
  for (const bounds of axisBounds) {
    assert.equal(rectanglesOverlap(point.turningCaption, bounds), false,
      `turning caption ${point.id} overlaps an axis label`);
  }
  const stem = {left: point.x - 1, top: Math.min(point.axisY, point.endpointY), width: 2,
    height: Math.abs(point.endpointY - point.axisY)};
  assert.equal(rectanglesOverlap(point.turningCaption, stem), false,
    `event leader for ${point.id} should not pass through its turning caption`);
}

test("numeric offsets remain anchored to the story origin at every zoom and pan", () => {
  const sourceEvent = event("origin-plus-five", 5);
  const initial = geometry([sourceEvent]).events[0];
  assert.equal(initial.x, 1200 / 2 + 160);

  const zoomedAndPanned = geometry([sourceEvent], {center: {x: 80, y: -20}, zoom: 2});
  assert.equal(zoomedAndPanned.events[0].x, 1200 / 2 + (160 - 80) * 2);
  assert.equal(zoomedAndPanned.events[0].axisY, 720 / 2 - (-20 * 2));
  assert.equal(sourceEvent.offset, 5, "layout does not rewrite event data");
});

test("nearby event labels are assigned separate vertical lanes without moving their x anchors", () => {
  const events = [event("a", 0.1), event("b", 0.2), event("c", 0.3)];
  const result = geometry(events);
  assert.deepEqual(Array.from(result.events, item => item.lane), [0, 1, 2]);
  assert.deepEqual(Array.from(result.events, item => item.x), events.map(item => 600 + (item.offset / 5) * 160));
  assert.ok(result.events[0].endpointY > result.events[1].endpointY);
  assert.ok(result.events[1].endpointY > result.events[2].endpointY);
});

test("above and below labels use independent lanes and respect edge alignment", () => {
  const result = geometry([
    event("above", 0.1),
    event("below", 0.2, {placement: "below"}),
    event("near-right-edge", 18),
  ]);
  const above = result.events.find(item => item.id === "above");
  const below = result.events.find(item => item.id === "below");
  const edge = result.events.find(item => item.id === "near-right-edge");
  assert.equal(above.lane, 0);
  assert.equal(below.lane, 0);
  assert.ok(above.endpointY < result.axisY);
  assert.ok(below.endpointY > result.axisY);
  assert.equal(edge.labelAlign, "right");
  assert.ok(edge.labelLeft + edge.labelWidth <= result.width - 8);
});

test("off-canvas events are omitted while malformed dimensions remain bounded", () => {
  const result = geometry([event("visible", 0), event("far-away", 1_000_000)]);
  assert.deepEqual(Array.from(result.events, item => item.id), ["visible"]);
  assert.equal(geometry([event("hidden", 0)], {width: Number.NaN}).events.length, 0);
});

test("distant anchors do not render clamped labels or occupy visible event lanes", () => {
  const result = geometry([event("far-before-origin", -1_000), event("visible", 0)], {
    center: {x: 0, y: 260},
  });
  assert.deepEqual(Array.from(result.events, item => item.id), ["visible"]);
  assert.equal(result.events[0].lane, 0);
});

test("short Chinese descriptions receive their actual character width before wrapping", () => {
  const result = geometry([event("letter", 0, {title: "故乡来信", summary: "一封没有署名的信"})]);
  assert.ok(result.events[0].labelWidth >= [..."一封没有署名的信"].length * 14);
});

test("short labels stay beside their anchors when the remaining edge space is enough", () => {
  const result = geometry([event("edge", 23, {title: "抵达故乡", summary: ""})], {
    width: 976,
    zoom: 0.5,
  });
  const point = result.events[0];
  assert.equal(point.labelAlign, "left");
  assert.ok(point.labelWidth <= 88);
  assert.ok(point.labelLeft + point.labelWidth <= result.width - 8);
});

test("origin critical-event captions avoid the year and origin description", () => {
  const {axis, eventLayout} = layoutAgainstAxis([event("origin-turn", 0, {important: true, placement: "below"})]);
  const point = eventLayout.events[0];
  assert.equal(point.x, 600, "the event remains anchored to its numeric origin");
  assert.ok(axis.labelBounds.length > 1, "the axis contributes both the year and origin caption bounds");
  assertCaptionAvoidsAxisAndStem(point, axis.labelBounds);
});

test("critical captions at non-origin major ticks clear the tick labels", () => {
  const {axis, eventLayout} = layoutAgainstAxis([event("next-major-year", 5, {important: true})]);
  const point = eventLayout.events[0];
  const major = axis.ticks.find(tick => tick.major && tick.worldX === 160);
  assert.ok(major?.labelVisible);
  assert.equal(point.x, 760, "the event stays at the matching major-tick position");
  assertCaptionAvoidsAxisAndStem(point, axis.labelBounds);
});

test("same-position important events receive separate captions without moving their anchors", () => {
  const events = [
    event("first-turn", 0, {important: true, placement: "below"}),
    event("second-turn", 0, {important: true, placement: "above"}),
  ];
  const {axis, eventLayout} = layoutAgainstAxis(events);
  const [first, second] = eventLayout.events;
  assert.equal(first.x, second.x);
  assertCaptionAvoidsAxisAndStem(first, axis.labelBounds);
  assertCaptionAvoidsAxisAndStem(second, axis.labelBounds);
  assert.equal(rectanglesOverlap(first.turningCaption, second.turningCaption), false,
    "important events at one x position need distinct text slots");
});

test("long year labels reserve enough room to keep a critical caption clear", () => {
  const settings = {origin: 1_000_000_000, step: 1, unit: "年"};
  const {axis, eventLayout} = layoutAgainstAxis([event("long-year-turn", 0, {important: true})], {settings});
  const point = eventLayout.events[0];
  const yearBounds = axis.labelBounds.find(bounds => bounds.top === 720 / 2 + 21
    && bounds.left < 1200 / 2 && bounds.left + bounds.width > 1200 / 2);
  assert.ok(yearBounds && yearBounds.width >= String(settings.origin).length * 8 + 16);
  assertCaptionAvoidsAxisAndStem(point, axis.labelBounds);
});

test("zoomed and panned captions stay inside the viewport near its edges", () => {
  const settings = {origin: 1_000_000_000, step: 1, unit: "年"};
  const {axis, eventLayout} = layoutAgainstAxis([event("edge-turn", 0, {important: true, placement: "below"})], {
    settings, width: 800, height: 600, zoom: 2, center: {x: 195, y: -140},
  });
  const point = eventLayout.events[0];
  const caption = point.turningCaption;
  assert.ok(caption);
  assert.ok(Math.abs(point.x - 10) < 1e-9, "panning and zooming preserve the event's screen-space anchor");
  assert.equal(point.axisY, axis.height / 2 - (-140 * 2));
  assert.ok(caption.left >= 8 && caption.left + caption.width <= 800 - 8);
  assert.ok(caption.top >= 8 && caption.top + caption.height <= 600 - 8,
    "when there is no room below the axis, the caption can move above it");
  assert.ok(caption.top + caption.height <= point.axisY,
    "near the viewport bottom, the caption is placed above the axis");
  assertCaptionAvoidsAxisAndStem(point, axis.labelBounds);
});

test("invisible origin ticks do not reserve space for event captions", () => {
  const {axis, eventLayout} = layoutAgainstAxis([event("near-edge-turn", 0, {important: true})], {
    width: 200, height: 400, center: {x: 90, y: 0},
  });
  const origin = axis.ticks.find(tick => tick.origin);
  const point = eventLayout.events[0];
  assert.equal(origin?.labelVisible, false);
  const originScreenX = 200 / 2 - 90;
  assert.ok(axis.labelBounds.every(bounds => bounds.left > originScreenX + 48
    || bounds.left + bounds.width < originScreenX - 48),
  "visible neighboring ticks should not be mistaken for the clipped origin label");
  assert.ok(point.turningCaption);
  assert.ok(point.turningCaption.top < point.axisY + 50,
    "hidden axis text does not force an unnecessary vertical displacement");
  assertCaptionAvoidsAxisAndStem(point, axis.labelBounds);
});
