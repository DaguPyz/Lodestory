import type {TimelineLabelBounds} from "./timelineAxisGeometry";

export type TimelineEventPlacement = "above" | "below";

export type TimelineEventPoint = Readonly<{
  id: string;
  title: string;
  summary: string;
  offset: number;
  placement: TimelineEventPlacement;
  important: boolean;
}>;

export type TimelineEventsGeometryInput = Readonly<{
  events: readonly TimelineEventPoint[];
  origin: number;
  step: number;
  center: Readonly<{x: number; y: number}>;
  zoom: number;
  width: number;
  height: number;
  axisLabelBounds?: readonly TimelineLabelBounds[];
}>;

export type TimelineEventGeometry = Readonly<{
  id: string;
  x: number;
  axisY: number;
  endpointY: number;
  lane: number;
  placement: TimelineEventPlacement;
  important: boolean;
  labelLeft: number;
  labelTop: number;
  labelWidth: number;
  labelAlign: "left" | "right";
  labelVisible: boolean;
  endpointVisible: boolean;
  turningCaption: TimelineLabelBounds | null;
  turningCaptionVisible: boolean;
}>;

export type TimelineEventsGeometry = Readonly<{
  width: number;
  height: number;
  axisY: number;
  labelBounds: readonly TimelineLabelBounds[];
  events: readonly TimelineEventGeometry[];
}>;

const BASE_PIXEL_INTERVAL = 160;
const ENDPOINT_GAP = 16;
const INITIAL_RISE = 144;
const LANE_RISE = 112;
const LABEL_MIN_WIDTH = 64;
const LABEL_MAX_WIDTH = 320;
const LABEL_GAP = 24;
const LABEL_HEIGHT = 112;
const EDGE_PADDING = 8;
export const TIMELINE_TURNING_CAPTION_FONT_SIZE = 12;
const CAPTION_WIDTH = 56;
const CAPTION_HEIGHT = 18;
const CAPTION_TOP = 28;
const CAPTION_GAP = 6;
const CAPTION_X_BUCKET = 4;

type CachedEvent = Readonly<{event: TimelineEventPoint; labelWidth: number}>;
type PreparedEvent = {
  event: TimelineEventPoint;
  x: number;
  labelWidth: number;
  labelLeft: number;
  labelAlign: "left" | "right";
  lane: number;
};
type HorizontalInterval = Readonly<{left: number; right: number}>;
type VerticalInterval = Readonly<{start: number; end: number}>;
type CaptionCandidateColumns = Readonly<{pointIndex: number; columns: readonly number[]}>;

const orderedEventCache = new WeakMap<readonly TimelineEventPoint[], readonly CachedEvent[]>();

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function estimateLabelWidth(event: TimelineEventPoint): number {
  const titleWidth = [...event.title].length * 20;
  const offsetWidth = Math.min(LABEL_MAX_WIDTH, String(event.offset).length * 8 + 48);
  // Summaries wrap to two lines in the view; this estimate gives them room without
  // letting a long summary push its event label past the canvas edge.
  const summaryWidth = Math.min(280, [...event.summary].reduce((width, character) =>
    width + (character.codePointAt(0)! > 255 ? 14 : 7.5), 0) + (event.summary ? 2 : 0));
  return clamp(Math.max(LABEL_MIN_WIDTH, titleWidth, offsetWidth, summaryWidth), LABEL_MIN_WIDTH, LABEL_MAX_WIDTH);
}

function getOrderedEvents(events: readonly TimelineEventPoint[]): readonly CachedEvent[] {
  const cached = orderedEventCache.get(events);
  if (cached) return cached;
  const ordered = events
    .filter(event => event && typeof event.id === "string" && Number.isFinite(event.offset))
    .map(event => Object.freeze({event, labelWidth: estimateLabelWidth(event)}))
    .sort((left, right) => left.event.offset - right.event.offset
      || left.event.id.localeCompare(right.event.id));
  const result = Object.freeze(ordered);
  orderedEventCache.set(events, result);
  return result;
}

function labelPosition(x: number, desiredWidth: number, width: number): {
  labelLeft: number;
  labelWidth: number;
  labelAlign: "left" | "right";
} {
  const available = Math.max(0, width - EDGE_PADDING * 2);
  const labelWidth = Math.min(desiredWidth, available || desiredWidth);
  const rightLeft = x + ENDPOINT_GAP;
  const rightRoom = width - EDGE_PADDING - rightLeft;
  const leftRight = x - ENDPOINT_GAP;
  const leftRoom = leftRight - EDGE_PADDING;
  const fitsRight = rightRoom >= labelWidth;
  const fitsLeft = leftRoom >= labelWidth;
  const preferRight = fitsRight || (!fitsLeft && rightRoom >= leftRoom);
  const labelAlign = preferRight ? "left" : "right";
  const rawLeft = preferRight ? rightLeft : leftRight - labelWidth;
  const labelLeft = clamp(rawLeft, EDGE_PADDING, width - EDGE_PADDING - labelWidth);
  return {labelLeft, labelWidth, labelAlign};
}

function intersectsCanvas(bounds: TimelineLabelBounds, width: number, height: number): boolean {
  return bounds.left < width && bounds.left + bounds.width > 0
    && bounds.top < height && bounds.top + bounds.height > 0;
}

function lowerBound<T>(items: readonly T[], target: number, getValue: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (getValue(items[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound<T>(items: readonly T[], target: number, getValue: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (getValue(items[middle]) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function insertUnion(intervals: VerticalInterval[] | undefined, start: number, end: number): VerticalInterval[] {
  const result = intervals ?? [];
  let low = 0;
  let high = result.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (result[middle].end < start) low = middle + 1;
    else high = middle;
  }
  let mergedStart = start;
  let mergedEnd = end;
  let stop = low;
  while (stop < result.length && result[stop].start <= mergedEnd) {
    mergedStart = Math.min(mergedStart, result[stop].start);
    mergedEnd = Math.max(mergedEnd, result[stop].end);
    stop++;
  }
  result.splice(low, stop - low, {start: mergedStart, end: mergedEnd});
  return result;
}

function mergeIntervals(intervals: VerticalInterval[]): VerticalInterval[] {
  if (intervals.length < 2) return intervals;
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let write = 0;
  for (let read = 1; read < intervals.length; read++) {
    const current = intervals[read];
    const previous = intervals[write];
    if (current.start <= previous.end) {
      intervals[write] = {start: previous.start, end: Math.max(previous.end, current.end)};
    } else {
      intervals[++write] = current;
    }
  }
  intervals.length = write + 1;
  return intervals;
}

class HorizontalIntervalIndex {
  private readonly intervals: HorizontalInterval[];
  private readonly prefixMaxRight: number[];

  constructor(intervals: readonly HorizontalInterval[]) {
    this.intervals = [...intervals].sort((left, right) => left.left - right.left);
    this.prefixMaxRight = [];
    let maxRight = Number.NEGATIVE_INFINITY;
    for (const interval of this.intervals) {
      maxRight = Math.max(maxRight, interval.right);
      this.prefixMaxRight.push(maxRight);
    }
  }

  overlaps(left: number, right: number): boolean {
    const count = lowerBound(this.intervals, right, interval => interval.left);
    return count > 0 && this.prefixMaxRight[count - 1] > left;
  }
}

type CaptionColumn = {
  bucket: number;
  left: number;
  intervals: VerticalInterval[];
  belowStart?: number;
  belowTop?: number;
  aboveStart?: number;
  aboveTop?: number;
};

/**
 * Stores one y-interval union per 4px caption column bucket. A bucket includes every
 * obstacle that could touch any caption position in it, so its union is conservative
 * by at most one bucket width and never permits overlap. This avoids obstacle×candidate
 * scans when hundreds of anchors sit within a few pixels of each other.
 */
class CaptionObstacleIndex {
  private readonly columns: CaptionColumn[];
  private readonly columnsByBucket: Map<number, CaptionColumn>;
  private readonly height: number;
  private readonly fullyBlockingBelow: HorizontalIntervalIndex;
  private readonly fullyBlockingAbove: HorizontalIntervalIndex;

  constructor(columnPositions: readonly number[], obstacles: readonly TimelineLabelBounds[], axisY: number, height: number) {
    this.height = height;
    const buckets = uniqueSorted(columnPositions.map(left => Math.floor(left / CAPTION_X_BUCKET)));
    this.columns = buckets.map(bucket => ({bucket, left: bucket * CAPTION_X_BUCKET, intervals: []}));
    this.columnsByBucket = new Map(this.columns.map(column => [column.bucket, column]));
    const belowStart = axisY + CAPTION_TOP;
    const aboveStart = axisY - CAPTION_TOP - CAPTION_HEIGHT;
    this.fullyBlockingBelow = new HorizontalIntervalIndex(obstacles.filter(obstacle =>
      obstacle.top - CAPTION_GAP < belowStart + CAPTION_HEIGHT
      && obstacle.top + obstacle.height + CAPTION_GAP >= height).map(obstacle => ({
      left: obstacle.left - CAPTION_GAP,
      right: obstacle.left + obstacle.width + CAPTION_GAP,
    })));
    this.fullyBlockingAbove = new HorizontalIntervalIndex(obstacles.filter(obstacle =>
      obstacle.top - CAPTION_GAP <= 0
      && obstacle.top + obstacle.height + CAPTION_GAP > aboveStart).map(obstacle => ({
      left: obstacle.left - CAPTION_GAP,
      right: obstacle.left + obstacle.width + CAPTION_GAP,
    })));
    for (const obstacle of obstacles) this.addBase(obstacle);
    for (const column of this.columns) column.intervals = mergeIntervals(column.intervals);
  }

  private forBucketsOverlapping(bounds: TimelineLabelBounds, visit: (column: CaptionColumn) => void): void {
    const left = bounds.left - CAPTION_GAP;
    const right = bounds.left + bounds.width + CAPTION_GAP;
    const first = lowerBound(this.columns, left - CAPTION_WIDTH - CAPTION_X_BUCKET,
      column => column.left);
    for (let index = first; index < this.columns.length && this.columns[index].left < right; index++) {
      const column = this.columns[index];
      if (column.left + CAPTION_X_BUCKET + CAPTION_WIDTH > left) visit(column);
    }
  }

  private addBase(bounds: TimelineLabelBounds): void {
    const interval = {start: bounds.top - CAPTION_GAP, end: bounds.top + bounds.height + CAPTION_GAP};
    this.forBucketsOverlapping(bounds, column => column.intervals.push(interval));
  }

  private add(bounds: TimelineLabelBounds): void {
    const start = bounds.top - CAPTION_GAP;
    const end = bounds.top + bounds.height + CAPTION_GAP;
    this.forBucketsOverlapping(bounds, column => {
      column.intervals = insertUnion(column.intervals, start, end);
      if (column.belowTop !== undefined && start < column.belowTop + CAPTION_HEIGHT && end > column.belowTop) {
        column.belowTop = this.findBelow(column.intervals, column.belowTop);
      }
      if (column.aboveTop !== undefined && start < column.aboveTop + CAPTION_HEIGHT && end > column.aboveTop) {
        column.aboveTop = this.findAbove(column.intervals, column.aboveTop);
      }
    });
  }

  private findBelow(intervals: readonly VerticalInterval[], initialTop: number): number {
    let top = initialTop;
    if (top >= this.height) return top;
    while (true) {
      const bottom = top + CAPTION_HEIGHT;
      let index = lowerBound(intervals, top, interval => interval.end);
      while (index < intervals.length && intervals[index].end <= top) index++;
      if (index >= intervals.length || intervals[index].start >= bottom) return top;
      top = intervals[index].end;
      if (top >= this.height) return top;
    }
  }

  private findAbove(intervals: readonly VerticalInterval[], initialTop: number): number {
    let top = initialTop;
    if (top + CAPTION_HEIGHT <= 0) return top;
    while (true) {
      const bottom = top + CAPTION_HEIGHT;
      const index = lowerBound(intervals, bottom, interval => interval.start) - 1;
      if (index < 0 || intervals[index].end <= top) return top;
      top = intervals[index].start - CAPTION_HEIGHT;
      if (top + CAPTION_HEIGHT <= 0) return top;
    }
  }

  positions(left: number, belowStart: number, aboveStart: number): {below: number; above: number} {
    const column = this.columnsByBucket.get(Math.floor(left / CAPTION_X_BUCKET));
    if (!column) return {below: belowStart, above: aboveStart};
    const blocksBelow = this.fullyBlockingBelow.overlaps(left, left + CAPTION_WIDTH);
    const blocksAbove = this.fullyBlockingAbove.overlaps(left, left + CAPTION_WIDTH);
    if (blocksBelow && blocksAbove) return {below: this.height, above: -CAPTION_HEIGHT};
    if (column.belowStart !== belowStart) {
      column.belowStart = belowStart;
      column.belowTop = this.findBelow(column.intervals, belowStart);
    }
    if (column.aboveStart !== aboveStart) {
      column.aboveStart = aboveStart;
      column.aboveTop = this.findAbove(column.intervals, aboveStart);
    }
    return {
      below: blocksBelow ? this.height : (column.belowTop ?? belowStart),
      above: blocksAbove ? -CAPTION_HEIGHT : (column.aboveTop ?? aboveStart),
    };
  }

  addCaption(bounds: TimelineLabelBounds): void {
    this.add(bounds);
  }
}

function captionColumns(x: number, width: number): number[] {
  const sideShift = CAPTION_WIDTH / 2 + 12;
  return [...new Set([x, x + sideShift, x - sideShift].map(center =>
    clamp(center - CAPTION_WIDTH / 2, EDGE_PADDING, width - EDGE_PADDING - CAPTION_WIDTH)))];
}

type ActiveLane = {end: number; lane: number};

function pushNumberHeap(heap: number[], value: number): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (heap[parent] <= value) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function popNumberHeap(heap: number[]): number {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right] < heap[left] ? right : left;
    if (heap[child] >= last) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function activeLaneLess(left: ActiveLane, right: ActiveLane): boolean {
  return left.end < right.end || (left.end === right.end && left.lane < right.lane);
}

function pushActiveLane(heap: ActiveLane[], value: ActiveLane): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!activeLaneLess(value, heap[parent])) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function popActiveLane(heap: ActiveLane[]): ActiveLane {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && activeLaneLess(heap[right], heap[left]) ? right : left;
    if (!activeLaneLess(heap[child], last)) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function obstacleBounds(point: Pick<PreparedEvent, "x" | "lane"> & {
  axisY: number;
  endpointY: number;
  labelLeft: number;
  labelTop: number;
  labelWidth: number;
}): TimelineLabelBounds[] {
  return [
    {left: point.labelLeft, top: point.labelTop, width: point.labelWidth, height: LABEL_HEIGHT},
    {left: point.x - 18, top: point.endpointY - 18, width: 36, height: 36},
    {left: point.x - 1, top: Math.min(point.axisY, point.endpointY), width: 2,
      height: Math.abs(point.endpointY - point.axisY)},
  ];
}

/**
 * Places event labels into the nearest free vertical lane. Each event's x coordinate
 * remains tied to its numeric offset from the story origin; only its label height changes.
 */
export function getTimelineEventsGeometry(input: TimelineEventsGeometryInput): TimelineEventsGeometry {
  const width = Number.isFinite(input.width) && input.width > 0 ? input.width : 0;
  const height = Number.isFinite(input.height) && input.height > 0 ? input.height : 0;
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const centerX = Number.isFinite(input.center.x) ? input.center.x : 0;
  const centerY = Number.isFinite(input.center.y) ? input.center.y : 0;
  const axisY = height / 2 - centerY * zoom;
  const step = Number.isFinite(input.step) && input.step > 0 ? input.step : 1;
  if (width === 0 || height === 0) return Object.freeze({width, height, axisY,
    labelBounds: Object.freeze([]), events: Object.freeze([])});

  const orderedEvents = getOrderedEvents(input.events);
  const projectedX = (offset: number) => width / 2 + ((offset / step) * BASE_PIXEL_INTERVAL - centerX) * zoom;
  const start = lowerBound(orderedEvents, -24, item => projectedX(item.event.offset));
  const end = upperBound(orderedEvents, width + 24, item => projectedX(item.event.offset));
  const candidates: Omit<PreparedEvent, "lane">[] = [];
  for (let index = start; index < Math.min(end, orderedEvents.length); index++) {
    const {event, labelWidth} = orderedEvents[index];
    const worldX = (event.offset / step) * BASE_PIXEL_INTERVAL;
    const x = width / 2 + (worldX - centerX) * zoom;
    // Labels may align at the canvas edge, but distant anchors must not occupy lanes.
    if (!Number.isFinite(x) || x < -24 || x > width + 24) continue;
    candidates.push({...labelPosition(x, labelWidth, width), event, x});
  }

  const laneAssignments = Array<number>(candidates.length);
  const laneStates = {
    above: {active: [] as ActiveLane[], available: [] as number[], nextLane: 0},
    below: {active: [] as ActiveLane[], available: [] as number[], nextLane: 0},
  };
  const laneOrder = candidates.map((_, index) => index).sort((left, right) =>
    candidates[left].labelLeft - candidates[right].labelLeft || left - right);
  for (const index of laneOrder) {
    const item = candidates[index];
    const state = laneStates[item.event.placement];
    while (state.active.length > 0 && state.active[0].end <= item.labelLeft) {
      pushNumberHeap(state.available, popActiveLane(state.active).lane);
    }
    const lane = state.available.length > 0 ? popNumberHeap(state.available) : state.nextLane++;
    laneAssignments[index] = lane;
    pushActiveLane(state.active, {end: item.labelLeft + item.labelWidth + LABEL_GAP, lane});
  }
  const prepared: PreparedEvent[] = candidates.map((item, index) => ({...item, lane: laneAssignments[index]}));

  const laidOut = prepared.map(item => {
    const isAbove = item.event.placement === "above";
    const endpointY = axisY + (isAbove ? -1 : 1) * (INITIAL_RISE + item.lane * LANE_RISE);
    const labelTop = isAbove ? endpointY - 40 : endpointY - 8;
    const labelBox = {left: item.labelLeft, top: labelTop, width: item.labelWidth, height: LABEL_HEIGHT};
    const endpointBox = {left: item.x - 18, top: endpointY - 18, width: 36, height: 36};
    const top = Math.min(axisY, endpointY - 18, labelTop);
    const bottom = Math.max(axisY, endpointY + 18, labelTop + LABEL_HEIGHT);
    // Keep axis anchors and leaders that cross the viewport, even when their label and
    // endpoint have moved beyond it; the renderer can independently omit clipped text/dots.
    if (bottom < 0 || top > height) return null;
    return Object.freeze({
      id: item.event.id,
      x: item.x,
      axisY,
      endpointY,
      lane: item.lane,
      placement: item.event.placement,
      important: item.event.important,
      labelLeft: item.labelLeft,
      labelTop,
      labelWidth: item.labelWidth,
      labelAlign: item.labelAlign,
      labelVisible: intersectsCanvas(labelBox, width, height),
      endpointVisible: intersectsCanvas(endpointBox, width, height),
      turningCaption: null,
      turningCaptionVisible: false,
    });
  }).filter((point): point is NonNullable<typeof point> => point !== null);

  const baseObstacles: TimelineLabelBounds[] = [
    ...(input.axisLabelBounds ?? []),
    ...laidOut.flatMap(point => obstacleBounds(point)),
  ];
  const captionRows: CaptionCandidateColumns[] = [];
  for (let index = 0; index < laidOut.length; index++) {
    const point = laidOut[index];
    if (!point.important || axisY < 0 || axisY > height) continue;
    const columns = captionColumns(point.x, width);
    captionRows.push({pointIndex: index, columns});
  }
  const visibleCaptionObstacles = baseObstacles.filter(bounds =>
    bounds.top - CAPTION_GAP < height - EDGE_PADDING
    && bounds.top + bounds.height + CAPTION_GAP > EDGE_PADDING);
  const captionIndex = captionRows.length > 0
    ? new CaptionObstacleIndex(captionRows.flatMap(row => row.columns), visibleCaptionObstacles, axisY, height)
    : null;

  const turningCaptions = new Map<number, TimelineLabelBounds>();
  const exhaustedCaptionColumns = new Set<string>();
  for (const row of captionRows) {
    const columnKey = row.columns.join(",");
    if (exhaustedCaptionColumns.has(columnKey)) continue;
    const point = laidOut[row.pointIndex];
    const candidatesForPoint: TimelineLabelBounds[] = [];
    for (const left of row.columns) {
      const position = captionIndex!.positions(left, axisY + CAPTION_TOP,
        axisY - CAPTION_TOP - CAPTION_HEIGHT);
      candidatesForPoint.push({left, top: position.below, width: CAPTION_WIDTH, height: CAPTION_HEIGHT});
      candidatesForPoint.push({left, top: position.above, width: CAPTION_WIDTH, height: CAPTION_HEIGHT});
    }
    const clipped = (box: TimelineLabelBounds) => Number(box.top < EDGE_PADDING || box.top + box.height > height - EDGE_PADDING);
    const distance = (box: TimelineLabelBounds) => Math.abs(box.top - (axisY + CAPTION_TOP))
      + Math.abs(box.left + box.width / 2 - point.x);
    candidatesForPoint.sort((left, right) => clipped(left) - clipped(right)
      || Number(left.top < axisY) - Number(right.top < axisY)
      || distance(left) - distance(right));
    const caption = Object.freeze(candidatesForPoint[0]);
    if (!candidatesForPoint.some(candidate => intersectsCanvas(candidate, width, height))) {
      // Occupied space only grows during this layout. Once every candidate column has
      // no viewport intersection, later captions at the same x cannot become visible.
      exhaustedCaptionColumns.add(columnKey);
      continue;
    }
    turningCaptions.set(row.pointIndex, caption);
    // Off-screen captions are not rendered and must not push later visible captions
    // farther away from the viewport. Recompute them after pan/zoom from the new view.
    if (intersectsCanvas(caption, width, height)) captionIndex!.addCaption(caption);
  }

  const labelBounds: TimelineLabelBounds[] = (input.axisLabelBounds ?? [])
    .filter(bounds => intersectsCanvas(bounds, width, height))
    .concat(laidOut.filter(point => point.labelVisible).map(point => Object.freeze({
      left: point.labelLeft, top: point.labelTop, width: point.labelWidth, height: LABEL_HEIGHT,
    })));
  const events = laidOut.map((point, index) => {
    const turningCaption = turningCaptions.get(index) ?? null;
    const turningCaptionVisible = turningCaption ? intersectsCanvas(turningCaption, width, height) : false;
    if (turningCaption && turningCaptionVisible) labelBounds.push(turningCaption);
    return Object.freeze({...point, turningCaption, turningCaptionVisible});
  });
  return Object.freeze({width, height, axisY, labelBounds: Object.freeze(labelBounds), events: Object.freeze(events)});
}
