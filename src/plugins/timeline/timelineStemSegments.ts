import type {TimelineEventGeometry, TimelineEventsGeometry} from "./timelineEventsGeometry";

export type TimelineStemSegment = Readonly<{
  id: string;
  x: number;
  y1: number;
  y2: number;
  start: number;
  end: number;
  important: boolean;
}>;

type BezierPoint = Readonly<{x: number; y: number}>;
type BezierCurve = readonly [BezierPoint, BezierPoint, BezierPoint, BezierPoint];
const BRANCH_CURVE: BezierCurve = [{x: 0, y: 0}, {x: 0, y: .55}, {x: .45, y: 1}, {x: 1, y: 1}];

function splitBezier(curve: BezierCurve, t: number): [BezierCurve, BezierCurve] {
  const mix = (a: BezierPoint, b: BezierPoint) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
  const a = mix(curve[0], curve[1]), b = mix(curve[1], curve[2]), c = mix(curve[2], curve[3]);
  const d = mix(a, b), e = mix(b, c), middle = mix(d, e);
  return [[curve[0], a, d, middle], [middle, e, c, curve[3]]];
}

function curveParameterAt(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let low = 0, high = 1;
  for (let i = 0; i < 20; i++) {
    const t = (low + high) / 2;
    const y = 3 * .55 * (1 - t) ** 2 * t + 3 * (1 - t) * t * t + t ** 3;
    if (y < progress) low = t; else high = t;
  }
  return (low + high) / 2;
}

/** Preserve the original easeOutCirc timing when a leader is split around text. */
export function getStemSegmentTiming(start: number, end: number): {start: number; end: number; easing: string} {
  const t0 = curveParameterAt(start), t1 = curveParameterAt(end);
  const left = splitBezier(BRANCH_CURVE, t1)[0];
  const segment = splitBezier(left, t1 ? t0 / t1 : 0)[1];
  const [p0, p1, p2, p3] = segment;
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  if (dx <= 1e-12 || dy <= 1e-12) return {start: p0.x, end: Math.max(p3.x, p0.x + 1e-6), easing: "linear"};
  const format = (value: number) => String(Number(value.toFixed(6)));
  return {start: p0.x, end: p3.x, easing: `cubic-bezier(${format((p1.x - p0.x) / dx)}, ${format((p1.y - p0.y) / dy)}, ${format((p2.x - p0.x) / dx)}, ${format((p2.y - p0.y) / dy)})`};
}

/** Split leaders around the same padded text bounds that previously formed the SVG mask. */
export function getTimelineStemSegments(geometry: TimelineEventsGeometry): readonly TimelineStemSegment[] {
  const bounds = geometry.labelBounds.map(box => ({left: box.left - 4, right: box.left + box.width + 4,
    top: box.top - 4, bottom: box.top + box.height + 4})).sort((a, b) => a.left - b.left);
  const points = [...geometry.events].sort((a, b) => a.x - b.x);
  const segments: TimelineStemSegment[] = [];
  let cursor = 0;
  const active: typeof bounds = [];
  for (const point of points) {
    if (point.x < -1 || point.x > geometry.width + 1) continue;
    while (cursor < bounds.length && bounds[cursor].left <= point.x) active.push(bounds[cursor++]);
    let keep = 0;
    for (const box of active) if (box.right >= point.x) active[keep++] = box;
    active.length = keep;
    appendSegments(point, active, geometry.height, segments);
  }
  return segments;
}

function appendSegments(point: TimelineEventGeometry, bounds: readonly {top: number; bottom: number}[], height: number, result: TimelineStemSegment[]) {
  const length = Math.abs(point.endpointY - point.axisY);
  if (!length) return;
  const direction = Math.sign(point.endpointY - point.axisY);
  const edgeA = (-1 - point.axisY) * direction, edgeB = (height + 1 - point.axisY) * direction;
  const visibleStart = Math.max(0, Math.min(edgeA, edgeB));
  const visibleEnd = Math.min(length, Math.max(edgeA, edgeB));
  if (visibleEnd <= visibleStart) return;
  const blocked: {start: number; end: number}[] = [];
  for (const box of bounds) {
    const a = (box.top - point.axisY) * direction;
    const b = (box.bottom - point.axisY) * direction;
    const start = Math.max(visibleStart, Math.min(a, b)), end = Math.min(visibleEnd, Math.max(a, b));
    if (end > start) blocked.push({start, end});
  }
  blocked.sort((a, b) => a.start - b.start);
  const add = (start: number, end: number) => {
    if (end <= start) return;
    result.push({id: point.id, x: point.x, y1: point.axisY + direction * start,
      y2: point.axisY + direction * end, start: start / length, end: end / length, important: point.important});
  };
  let position = visibleStart;
  for (const interval of blocked) {
    add(position, interval.start);
    position = Math.max(position, interval.end);
  }
  add(position, visibleEnd);
}
