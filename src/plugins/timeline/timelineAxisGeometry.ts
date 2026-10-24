export type TimelineAxisSettings = Readonly<{origin: number; step: number; unit: string}>;

/** Text occupancy in CSS pixels, independent of the canvas zoom. */
export type TimelineLabelBounds = Readonly<{left: number; top: number; width: number; height: number}>;

export const TIMELINE_AXIS_LABEL_LAYOUT = Object.freeze({
  valueTop: 21, valueFontSize: 14, valueHeight: 18,
  originTop: 41, originFontSize: 11, originWidth: 56, originHeight: 16,
});

export type TimelineAxisTick = Readonly<{
  /** X coordinate relative to the viewport's world-space center. */
  x: number;
  /** Absolute world-space X coordinate used by the value mapping. */
  worldX: number;
  /** Value represented by this tick. Minor ticks are unlabeled. */
  value: number;
  major: boolean;
  labelVisible: boolean;
  origin: boolean;
  key: number;
}>;

export type TimelineAxisGeometry = Readonly<{
  width: number;
  height: number;
  worldWidth: number;
  worldHeight: number;
  centerX: number;
  centerY: number;
  axisY: number;
  arrowBaseX: number;
  arrowTipX: number;
  ticks: readonly TimelineAxisTick[];
  labelBounds: readonly TimelineLabelBounds[];
  majorFactor: number;
  majorWorldSpacing: number;
}>;

export type TimelineAxisGeometryInput = Readonly<{
  center: Readonly<{x: number; y: number}>;
  zoom: number;
  width: number;
  height: number;
  settings: TimelineAxisSettings;
}>;

export const TIMELINE_AXIS_BASE_PIXEL_INTERVAL = 160;
const TARGET_MAJOR_SPACING = 128;
const MINOR_DIVISIONS = 5;
const MAX_TICKS = 256;

/** Value mapping is anchored at world X = 0 and does not depend on zoom or pan. */
export function timelineValueAtWorldX(worldX: number, settings: TimelineAxisSettings): number {
  return settings.origin + (worldX / TIMELINE_AXIS_BASE_PIXEL_INTERVAL) * settings.step;
}

/** Inverse of timelineValueAtWorldX, useful to place values in world coordinates. */
export function timelineWorldXForValue(value: number, settings: TimelineAxisSettings): number {
  return ((value - settings.origin) / settings.step) * TIMELINE_AXIS_BASE_PIXEL_INTERVAL;
}

/** Keeps main labels near a readable screen-space spacing using a 1–2–5 sequence. */
export function timelineMajorFactor(zoom: number): number {
  return timelineMajorFactorForSpacing(zoom, TARGET_MAJOR_SPACING);
}

function timelineMajorFactorForSpacing(zoom: number, targetSpacing: number): number {
  const target = targetSpacing / (TIMELINE_AXIS_BASE_PIXEL_INTERVAL * zoom);
  if (!Number.isFinite(target) || target <= 0) return 1;
  const exponent = Math.floor(Math.log10(target));
  for (let power = exponent - 1; power <= exponent + 2; power++) {
    const scale = 10 ** power;
    for (const multiplier of [1, 2, 5, 10]) {
      const candidate = multiplier * scale;
      if (candidate >= target * (1 - Number.EPSILON * 4)) return candidate;
    }
  }
  return 1;
}

function decimalPlaces(value: number): number {
  const text = Math.abs(value).toString().toLowerCase();
  const [mantissa, exponentText] = text.split("e");
  const fractionDigits = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
  return Math.max(0, fractionDigits - Number(exponentText ?? 0));
}

/** Add a stored story-relative position without exposing binary rounding tails in labels. */
export function timelineValueAtOffset(offset: number, settings: Pick<TimelineAxisSettings, "origin">): number {
  const value = settings.origin + offset;
  const precision = Math.max(decimalPlaces(settings.origin), decimalPlaces(offset));
  return precision <= 100 && Math.abs(value) < 1e21 ? Number(value.toFixed(precision)) : value;
}

function mappedTickValue(index: number, majorFactor: number, settings: TimelineAxisSettings): number {
  // Compute each tick from the origin and index; never accumulate a rounded interval.
  const coefficientPrecision = Math.min(100, decimalPlaces(majorFactor) + 1);
  const coefficient = Number(((index * majorFactor) / MINOR_DIVISIONS).toFixed(coefficientPrecision));
  const value = settings.origin + coefficient * settings.step;
  const precision = Math.max(decimalPlaces(settings.origin), decimalPlaces(settings.step) + decimalPlaces(coefficient));
  return precision <= 100 && Math.abs(value) < 1e21 ? Number(value.toFixed(precision)) : value;
}

export function getTimelineAxisGeometry(input: TimelineAxisGeometryInput): TimelineAxisGeometry {
  const {center, width, height, settings} = input;
  const zoom = input.zoom;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
  const worldWidth = safeWidth / safeZoom;
  const worldHeight = safeHeight / safeZoom;
  const centerX = Number.isFinite(center.x) ? center.x : 0;
  const centerY = Number.isFinite(center.y) ? center.y : 0;
  const left = centerX - worldWidth / 2;
  const right = centerX + worldWidth / 2;
  const edgeValues = [timelineValueAtWorldX(left, settings), timelineValueAtWorldX(right, settings)];
  const estimatedLabelWidth = edgeValues.reduce((largest, value) => Number.isFinite(value)
    ? Math.max(largest, formatTimelineAxisValue(value).length * 8 + 16) : largest, 0);
  const majorFactor = timelineMajorFactorForSpacing(safeZoom, Math.max(TARGET_MAJOR_SPACING, estimatedLabelWidth, 56));
  const majorWorldSpacing = TIMELINE_AXIS_BASE_PIXEL_INTERVAL * majorFactor;
  const minorWorldSpacing = majorWorldSpacing / MINOR_DIVISIONS;
  const firstIndex = Math.ceil(left / minorWorldSpacing - Number.EPSILON * 4);
  const lastIndex = Math.floor(right / minorWorldSpacing + Number.EPSILON * 4);
  const visibleTickCount = lastIndex - firstIndex + 1;
  const ticks: TimelineAxisTick[] = [];
  const labelBounds: TimelineLabelBounds[] = [];
  const axisScreenY = safeHeight / 2 - centerY * safeZoom;

  // A viewport is small enough that this should never be reached at supported zooms.
  // Keep a hard bound in case a malformed or future viewport supplies extreme dimensions.
  if (Number.isSafeInteger(firstIndex) && Number.isSafeInteger(lastIndex) && visibleTickCount > 0 && visibleTickCount <= MAX_TICKS
    && Number.isFinite(settings.origin) && Number.isFinite(settings.step) && settings.step > 0) {
    for (let index = firstIndex; index <= lastIndex; index++) {
      const worldX = index * minorWorldSpacing;
      const major = index % MINOR_DIVISIONS === 0;
      const value = mappedTickValue(index, majorFactor, settings);
      if (!Number.isFinite(value)) continue;
      const relativeX = worldX - centerX;
      const screenX = (relativeX + worldWidth / 2) * safeZoom;
      const labelWidth = Math.max(formatTimelineAxisValue(value).length * 8, index === 0 ? 56 : 0) + 16;
      const labelVisible = major && screenX >= labelWidth / 2 && safeWidth - screenX >= labelWidth / 2;
      ticks.push(Object.freeze({
        x: relativeX,
        worldX,
        value,
        major,
        labelVisible,
        origin: index === 0,
        key: index,
      }));
      if (labelVisible && axisScreenY >= 0 && axisScreenY <= safeHeight) {
        const layout = TIMELINE_AXIS_LABEL_LAYOUT;
        labelBounds.push(Object.freeze({left: screenX - labelWidth / 2,
          top: axisScreenY + layout.valueTop, width: labelWidth, height: layout.valueHeight}));
        if (index === 0) labelBounds.push(Object.freeze({left: screenX - layout.originWidth / 2,
          top: axisScreenY + layout.originTop, width: layout.originWidth, height: layout.originHeight}));
      }
    }
  }

  return Object.freeze({
    width: safeWidth,
    height: safeHeight,
    worldWidth,
    worldHeight,
    centerX,
    centerY,
    axisY: -centerY,
    arrowBaseX: worldWidth / 2 - 12 / safeZoom,
    arrowTipX: worldWidth / 2 - 2 / safeZoom,
    ticks: Object.freeze(ticks),
    labelBounds: Object.freeze(labelBounds),
    majorFactor,
    majorWorldSpacing,
  });
}

export function formatTimelineAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Object.is(value, -0) ? "0" : String(value);
}
