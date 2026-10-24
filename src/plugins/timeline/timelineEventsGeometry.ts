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
  turningCaption: TimelineLabelBounds | null;
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
const MAX_LAID_OUT_EVENTS = 2048;
export const TIMELINE_TURNING_CAPTION_FONT_SIZE = 12;
const CAPTION_WIDTH = 56;
const CAPTION_HEIGHT = 18;
const CAPTION_TOP = 28;
const CAPTION_GAP = 6;

type PreparedEvent = {
  event: TimelineEventPoint;
  x: number;
  labelWidth: number;
  labelLeft: number;
  labelAlign: "left" | "right";
  lane: number;
};

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

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd + LABEL_GAP && end + LABEL_GAP > otherStart;
}

function placeTurningCaption(x: number, axisY: number, width: number, height: number,
  obstacles: readonly TimelineLabelBounds[]): TimelineLabelBounds {
  // Prefer the anchor's column. Side positions let labels clear downward stems
  // without moving the event's actual position on the numeric axis.
  const sideShift = CAPTION_WIDTH / 2 + 12;
  const positions = [...new Set([x, x + sideShift, x - sideShift].map(center =>
    clamp(center - CAPTION_WIDTH / 2, EDGE_PADDING, width - EDGE_PADDING - CAPTION_WIDTH)))];
  const candidates: TimelineLabelBounds[] = [];
  for (const left of positions) {
    const inColumn = obstacles.filter(box => left < box.left + box.width + CAPTION_GAP
      && left + CAPTION_WIDTH + CAPTION_GAP > box.left).sort((a, b) => a.top - b.top);
    let top = axisY + CAPTION_TOP;
    for (const box of inColumn) {
      if (top < box.top + box.height + CAPTION_GAP && top + CAPTION_HEIGHT + CAPTION_GAP > box.top) {
        top = box.top + box.height + CAPTION_GAP;
      }
    }
    candidates.push({left, top, width: CAPTION_WIDTH, height: CAPTION_HEIGHT});
    // Near the bottom edge, use free space above the axis before clipping a caption.
    let aboveTop = axisY - CAPTION_TOP - CAPTION_HEIGHT;
    for (const box of [...inColumn].reverse()) {
      if (aboveTop < box.top + box.height + CAPTION_GAP && aboveTop + CAPTION_HEIGHT + CAPTION_GAP > box.top) {
        aboveTop = box.top - CAPTION_GAP - CAPTION_HEIGHT;
      }
    }
    candidates.push({left, top: aboveTop, width: CAPTION_WIDTH, height: CAPTION_HEIGHT});
  }
  const clipped = (box: TimelineLabelBounds) => Number(box.top < EDGE_PADDING || box.top + box.height > height - EDGE_PADDING);
  const distance = (box: TimelineLabelBounds) => Math.abs(box.top - (axisY + CAPTION_TOP)) + Math.abs(box.left + box.width / 2 - x);
  candidates.sort((a, b) => clipped(a) - clipped(b) || Number(a.top < axisY) - Number(b.top < axisY) || distance(a) - distance(b));
  return Object.freeze(candidates[0]);
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
  const prepared: PreparedEvent[] = [];
  const orderedEvents = [...input.events]
    .filter(event => event && typeof event.id === "string" && Number.isFinite(event.offset))
    .sort((left, right) => left.offset - right.offset || left.id.localeCompare(right.id))
    .slice(0, MAX_LAID_OUT_EVENTS);

  for (const event of orderedEvents) {
    const worldX = (event.offset / step) * BASE_PIXEL_INTERVAL;
    const x = width / 2 + (worldX - centerX) * zoom;
    // Keep out-of-view anchors out of label placement entirely. Clamped labels are
    // useful at the canvas edge, but must not make distant events visible or occupy lanes.
    if (!Number.isFinite(x) || x < -24 || x > width + 24) continue;
    const position = labelPosition(x, estimateLabelWidth(event), width);
    const labelEnd = position.labelLeft + position.labelWidth;
    const lanes = prepared.filter(item => item.event.placement === event.placement);
    const occupied = new Set<number>();
    for (const other of lanes) {
      if (overlaps(position.labelLeft, labelEnd, other.labelLeft, other.labelLeft + other.labelWidth)) occupied.add(other.lane);
    }
    let lane = 0;
    while (occupied.has(lane)) lane++;
    prepared.push({...position, event, x, lane});
  }

  const laidOut = prepared.map(item => {
    const isAbove = item.event.placement === "above";
    const endpointY = axisY + (isAbove ? -1 : 1) * (INITIAL_RISE + item.lane * LANE_RISE);
    const labelTop = isAbove ? endpointY - 40 : endpointY - 8;
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
      turningCaption: null,
    });
  }).filter(event => {
    const top = Math.min(axisY, event.endpointY, event.labelTop);
    const bottom = Math.max(axisY, event.endpointY, event.labelTop + LABEL_HEIGHT);
    const intersectsCanvas = bottom >= 0 && top <= height;
    return intersectsCanvas;
  });

  const labelBounds: TimelineLabelBounds[] = [...(input.axisLabelBounds ?? []),
    ...laidOut.map(point => Object.freeze({left: point.labelLeft, top: point.labelTop, width: point.labelWidth, height: LABEL_HEIGHT}))];
  const obstacles: TimelineLabelBounds[] = [...labelBounds];
  for (const point of laidOut) {
    obstacles.push({left: point.x - 18, top: point.endpointY - 18, width: 36, height: 36},
      {left: point.x - 1, top: Math.min(axisY, point.endpointY), width: 2, height: Math.abs(point.endpointY - axisY)});
  }
  const events = laidOut.map(point => {
    if (!point.important || axisY < 0 || axisY > height) return point;
    const turningCaption = placeTurningCaption(point.x, axisY, width, height, obstacles);
    obstacles.push(turningCaption);
    labelBounds.push(turningCaption);
    return Object.freeze({...point, turningCaption});
  });
  return Object.freeze({width, height, axisY, labelBounds: Object.freeze(labelBounds), events: Object.freeze(events)});
}
