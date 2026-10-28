import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const ts = createRequire(import.meta.url)("typescript");
const source = readFileSync(new URL("../src/plugins/timeline/timelineStemSegments.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const module = {exports: {}};
vm.runInNewContext(compiled, {module, exports: module.exports});
const {getTimelineStemSegments, getStemSegmentTiming} = module.exports;

test("leaders preserve their direction and avoid padded, overlapping text bounds", () => {
  const point = (id, x, endpointY) => ({id, x, axisY: 100, endpointY, important: false});
  const geometry = {width: 300, height: 200, events: [point("above", 50, 0), point("below", 150, 200), point("clear", 250, 200)],
    labelBounds: [
      {left: 45, top: 30, width: 10, height: 10},
      {left: 145, top: 120, width: 10, height: 20},
      {left: 145, top: 135, width: 10, height: 15},
      {left: 500, top: 0, width: 20, height: 200},
    ]};
  const segments = Array.from(getTimelineStemSegments(geometry), ({id, y1, y2}) => [id, y1, y2]);
  assert.deepEqual(segments, [["above", 100, 44], ["above", 26, 0],
    ["below", 100, 116], ["below", 154, 200], ["clear", 100, 200]]);
});

test("offscreen leader portions do not consume animation work", () => {
  const geometry = {width: 300, height: 200, labelBounds: [], events: [
    {id: "crossing", x: 50, axisY: 100, endpointY: -500, important: false},
    {id: "outside", x: 500, axisY: 100, endpointY: 0, important: false},
  ]};
  const segments = Array.from(getTimelineStemSegments(geometry));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, "crossing");
  assert.equal(segments[0].y1, 100);
  assert.equal(segments[0].y2, -1);
  assert.ok(segments[0].end < 1, "reveal timing remains relative to the full leader");
});

test("split leaders retain the selected easing and its continuous timing", () => {
  const whole = getStemSegmentTiming(0, 1);
  assert.equal(whole.easing, "cubic-bezier(0, 0.55, 0.45, 1)");
  assert.equal(whole.start, 0);
  assert.equal(whole.end, 1);
  const first = getStemSegmentTiming(0, .3);
  const second = getStemSegmentTiming(.3, .8);
  const last = getStemSegmentTiming(.8, 1);
  assert.ok(Math.abs(first.end - second.start) < 1e-9);
  assert.ok(Math.abs(second.end - last.start) < 1e-9);
  assert.ok(first.start < first.end && second.start < second.end && last.start < last.end);
});
