import {memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type MouseEvent, type RefObject} from "react";
import {Menu} from "@base-ui/react/menu";
import {Popover} from "@base-ui/react/popover";
import type {CanvasService, CanvasViewportSnapshot} from "@lodestory/sdk/canvas";
import type {ContextMenuService, MenuEntry} from "@lodestory/sdk/context-menu";
import type {AssetCatalog} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationNetwork} from "@lodestory/sdk/asset-relations";
import {Button, Dialog, DialogActions, DialogClose, Icon, IconButton, TextField, Textarea, useInteractionRef} from "@lodestory/ui";
import type {TimelineAxisSettings} from "./timelineAxisStore";
import {isTimelineEventColor, type TimelineEvent, type TimelineEventStore} from "./timelineEventStore";
import {getTimelineEventsGeometry, timelineEventWorldX, TIMELINE_TURNING_CAPTION_FONT_SIZE, type TimelineEventGeometry, type TimelineEventsGeometry} from "./timelineEventsGeometry";
import {getTimelineStemSegments, type TimelineStemSegment} from "./timelineStemSegments";
import {formatTimelineAxisValue, timelineValueAtOffset, type TimelineLabelBounds} from "./timelineAxisGeometry";
import {EventAssetPicker} from "./EventAssetPicker";
import {TimelineFocusAssets, type AssetClickPosition, type FocusedAsset, type TimelineFocusTarget} from "./TimelineFocusAssets";
import "./timeline-events.css";

type Size = Readonly<{width: number; height: number}>;
type View = Pick<CanvasViewportSnapshot, "center" | "zoom">;
type Draft = {id: string | null; title: string; summary: string; offset: string; placement: "above" | "below"; important: boolean; assetIds: readonly string[]; color: string};
type Operation = {kind: "upsert"; draft: Draft} | {kind: "remove"; id: string};
type EventMenuTarget = Readonly<{store: TimelineEventStore; eventId?: string}>;
type DeleteTarget = Readonly<{id: string; title: string; source: "canvas" | "editor"}>;
type EventFocus = Readonly<{
  id: string;
  store: TimelineEventStore;
  view: View;
  openToken?: string | null;
  closing?: boolean;
  asset?: FocusedAsset | null;
  assetClickPosition?: AssetClickPosition | null;
}>;

const EVENT_COLORS = [
  {name: "红色", value: "#d96666"}, {name: "橙色", value: "#d58a51"},
  {name: "黄色", value: "#c6a044"}, {name: "绿色", value: "#68a778"},
  {name: "青色", value: "#59a8a5"}, {name: "蓝色", value: "#6b9bce"},
  {name: "紫色", value: "#a489c9"}, {name: "粉色", value: "#ce83a2"},
] as const;

function EventActions({disabled, onDelete}: {disabled: boolean; onDelete(): void}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  const interactionRef = useInteractionRef<HTMLDivElement>(open && !disabled, "menu");

  return <Menu.Root modal={false} open={open && !disabled} onOpenChange={next => {
    if (next) setDensity(trigger.current?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity);
    setOpen(next);
  }}>
    <Menu.Trigger ref={trigger} disabled={disabled} render={<IconButton label="更多操作" />}><Icon name="more" /></Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner className="timeline-event-popup-positioner" data-ui-density={density} align="end" sideOffset={4} collisionPadding={8}>
        <Menu.Popup className="timeline-event-popup timeline-event-menu" ref={interactionRef}>
          <Menu.Item className="timeline-event-menu-item" onClick={onDelete}>删除事件</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}

function EventColorPicker({value, valid, disabled, onChange}: {
  value: string; valid: boolean; disabled: boolean; onChange(value: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  const interactionRef = useInteractionRef<HTMLDivElement>(open && !disabled, "popover");
  const selected = EVENT_COLORS.find(color => color.value === value.toLowerCase());

  return <div className="timeline-event-color">
    <div className="timeline-event-color-row">
      <span id={id}>颜色标记</span>
      <Popover.Root open={open && !disabled} onOpenChange={next => {
        if (next) setDensity(trigger.current?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity);
        setOpen(next);
      }}>
        <Popover.Trigger ref={trigger} disabled={disabled} aria-labelledby={`${id} ${id}-value`} aria-invalid={!valid || undefined}
          aria-describedby={!valid ? `${id}-error` : undefined} render={<Button variant="secondary" />}>
          <span className="timeline-event-color-swatch" aria-hidden="true" style={valid && value ? {backgroundColor: value} : undefined} />
          <span id={`${id}-value`}>{value ? selected?.name ?? "自定义" : "默认"}</span>
          <Icon name="chevronDown" size="small" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="timeline-event-popup-positioner" data-ui-density={density} align="end" sideOffset={4} collisionPadding={8}>
            <Popover.Popup className="timeline-event-popup timeline-event-color-popup" ref={interactionRef} aria-label="选择颜色">
              <fieldset className="timeline-event-color-picker" aria-label="预设颜色" disabled={disabled}>
                <div className="timeline-event-color-options">
                  <label className="timeline-event-color-choice timeline-event-color-default">
                    <input type="radio" name={id} checked={!value} onChange={() => onChange("")} />
                    <span>默认</span>
                  </label>
                  {EVENT_COLORS.map(color => <label className="timeline-event-color-choice" key={color.value} title={color.name}>
                    <input type="radio" name={id} aria-label={color.name} checked={selected === color} onChange={() => onChange(color.value)} />
                    <span style={{"--timeline-event-swatch": color.value} as CSSProperties} />
                  </label>)}
                </div>
                <div className="timeline-event-color-custom">
                  <label>自定义 <input type="color" aria-label="自定义颜色" value={value && valid ? value : "#6b9bce"}
                    onChange={event => onChange(event.currentTarget.value)} /></label>
                  <TextField aria-label="颜色值" aria-invalid={!valid || undefined} autoComplete="off" spellCheck={false}
                    placeholder="#RRGGBB" maxLength={7} value={value} onChange={event => onChange(event.currentTarget.value)} />
                </div>
              </fieldset>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
    {!valid && <p id={`${id}-error`} className="timeline-event-form-error" role="alert">颜色值需要使用 #RRGGBB 格式。</p>}
  </div>;
}

function draftFromEvent(event?: TimelineEvent): Draft {
  return event
    ? {id: event.id, title: event.title, summary: event.summary, offset: String(event.offset), placement: event.placement, important: event.important, assetIds: [...event.assetIds], color: event.color ?? ""}
    : {id: null, title: "", summary: "", offset: "0", placement: "above", important: false, assetIds: [], color: ""};
}

function signedAxisValue(value: number): string {
  const text = formatTimelineAxisValue(value);
  return value > 0 ? `+${text}` : text;
}

function calloutLabel(settings: TimelineAxisSettings, event: TimelineEvent): string {
  const value = timelineValueAtOffset(event.offset, settings);
  return `${signedAxisValue(value)} ${settings.unit}`;
}

function eventAccessibleName(settings: TimelineAxisSettings, event: TimelineEvent): string {
  const marker = event.important ? "关键转折" : "普通事件";
  const summary = event.summary ? `，${event.summary}` : "";
  return `${marker}：${event.title}${summary}，${calloutLabel(settings, event)}，${event.placement === "above" ? "轴线上方" : "轴线下方"}`;
}

function formatOffsetHint(settings: TimelineAxisSettings, offsetText: string): string {
  const offset = Number(offsetText);
  return Number.isFinite(offset)
    ? `对应轴上数值 ${formatTimelineAxisValue(timelineValueAtOffset(offset, settings))} ${settings.unit}`
    : `故事起点为 ${formatTimelineAxisValue(settings.origin)} ${settings.unit}`;
}

const AxisMarkerGlyph = memo(function AxisMarkerGlyph({important, origin}: {important: boolean; origin: boolean}) {
  return important
    ? <><rect x="-5.5" y="-5.5" width="11" height="11" transform="rotate(45)" /><circle r="1.8" /></>
    : <circle r={origin ? 5 : 4} />;
});

const EndpointGlyph = memo(function EndpointGlyph() {
  return <>
    <circle className="timeline-event-endpoint-hit" r="18" />
    <circle className="timeline-event-endpoint-contrast" r="11" />
    <circle className="timeline-event-endpoint-ring" r="11" />
    <circle className="timeline-event-endpoint-dot" r="5" />
  </>;
});

const AxisAnchor = memo(function AxisAnchor({event, x, active, hidden, onEdit}: {
  event: TimelineEvent;
  x: number;
  active: boolean;
  hidden: boolean;
  onEdit(event: TimelineEvent): void;
}) {
  const origin = event.offset === 0;
  const markerClass = ["timeline-event-axis-marker", origin ? "timeline-event-axis-marker-origin" : "",
    event.important ? "timeline-event-axis-marker-important" : ""].filter(Boolean).join(" ");
  return <g className="timeline-event-markers" data-active={active}>
    <g className={markerClass} aria-hidden="true" data-focus-hidden={hidden || undefined} data-canvas-interactive data-timeline-event-id={event.id}
      transform={`translate(${x} 0)`} onDoubleClick={() => { if (active) onEdit(event); }}>
      <AxisMarkerGlyph important={event.important} origin={origin} />
    </g>
  </g>;
});

/** A stable set of native hit targets; panning only translates the enclosing group. */
const AxisAnchors = memo(function AxisAnchors({events, step, zoom, originWorldX, active, focusedAxisId, onEdit}: {
  events: readonly TimelineEvent[];
  step: number;
  zoom: number;
  originWorldX: number;
  active: boolean;
  focusedAxisId: string | null;
  onEdit(event: TimelineEvent): void;
}) {
  const count = Math.min(24, events.length);
  return <>{Array.from({length: count}, (_, index) => {
    const group = events.slice(Math.floor(index * events.length / count), Math.floor((index + 1) * events.length / count));
    return <g key={group[0].id} data-growth-anchor={group[0].id}>{group.map(event => {
      const x = (timelineEventWorldX(event.offset, step) - originWorldX) * zoom;
      return <AxisAnchor key={event.id} event={event} x={x} active={active}
        hidden={focusedAxisId !== null && focusedAxisId !== event.id} onEdit={onEdit} />;
    })}</g>;
  })}</>;
});

function EventAxisMarkers({eventById, settings, geometry, stemSegments, centerX, zoom, textScale, active, focusedId, onFocusEvent, onEdit}: {
  eventById: ReadonlyMap<string, TimelineEvent>;
  settings: TimelineAxisSettings;
  geometry: ReturnType<typeof getTimelineEventsGeometry>;
  stemSegments: readonly TimelineStemSegment[];
  centerX: number;
  zoom: number;
  textScale: number;
  active: boolean;
  focusedId: string | null;
  onFocusEvent(id: string): void;
  onEdit(event: TimelineEvent): void;
}) {
  // Only membership/data/zoom changes rebuild the anchors; view movement does not.
  const markerIds = geometry.events.map(point => point.id).join(",");
  const markerEvents = useMemo(() => markerIds ? markerIds.split(",").flatMap(id => {
    const event = eventById.get(id);
    return event ? [event] : [];
  }) : [], [eventById, markerIds]);
  // Nearby world-space origins keep SVG coordinates small without relocating all
  // existing anchors whenever one event enters/leaves the viewport.
  const originWorldX = Math.floor(centerX / 4096) * 4096;
  const stems = [[], []] as [string[], string[]];
  for (const segment of stemSegments) {
    stems[Number(segment.important)].push(`M${segment.x} ${segment.y1}V${segment.y2}`);
  }
  return <svg className="timeline-events-svg" aria-hidden={Boolean(focusedId)} width={geometry.width} height={geometry.height}
    viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
    <g className="timeline-event-stems" aria-hidden="true">
      {stems[0].length > 0 && <path className="timeline-event-stem" d={stems[0].join("")} />}
      {stems[1].length > 0 && <path className="timeline-event-stem timeline-event-stem-important" d={stems[1].join("")} />}
    </g>
    <g className="timeline-event-axis-anchors" data-focus-hidden={Boolean(focusedId) || undefined}>
      <g transform={`translate(${geometry.width / 2 + (originWorldX - centerX) * zoom} ${geometry.axisY})`}>
        <AxisAnchors events={markerEvents} step={settings.step} zoom={zoom} originWorldX={originWorldX}
          active={active} focusedAxisId={focusedId} onEdit={onEdit} />
      </g>
    </g>
    <g className="timeline-event-details">{geometry.events.map(point => {
      if (focusedId && point.id !== focusedId) return null;
      if (!point.endpointVisible && !point.turningCaptionVisible) return null;
      const event = eventById.get(point.id);
      if (!event) return null;
      const originEvent = event.offset === 0;
      return <g key={event.id} data-growth-event={event.id} data-timeline-event-id={event.id}>
        {point.turningCaptionVisible && point.turningCaption && <g className="timeline-event-axis-marker" data-focus-hidden={Boolean(focusedId) || undefined}
          aria-hidden="true" data-canvas-interactive transform={`translate(${point.x} ${point.axisY})`}
          onDoubleClick={() => { if (active) onEdit(event); }}>
          <text className="timeline-event-turning-caption"
            x={point.turningCaption.left + point.turningCaption.width / 2 - point.x} y={point.turningCaption.top - point.axisY}
            fontSize={TIMELINE_TURNING_CAPTION_FONT_SIZE * textScale} textAnchor="middle" dominantBaseline="hanging">关键转折</text>
        </g>}
        {point.endpointVisible && <g className={["timeline-event-endpoint", originEvent ? "timeline-event-endpoint-origin" : "",
          event.important ? "timeline-event-endpoint-important" : ""].filter(Boolean).join(" ")}
          style={event.color ? {"--timeline-event-color": event.color} as CSSProperties : undefined}
          data-custom-color={event.color ? "true" : undefined}
          role="button" tabIndex={active && !focusedId ? 0 : -1}
          aria-label={eventAccessibleName(settings, event)} aria-disabled={!active}
          aria-expanded={focusedId === event.id} aria-description="右键菜单或空格查看关联资产，Enter 编辑事件。"
          data-canvas-interactive transform={`translate(${point.x} ${point.endpointY})`}
          onDoubleClick={() => { if (active) onEdit(event); }}
          onKeyDown={nativeEvent => {
            if (!active || nativeEvent.nativeEvent.isComposing || nativeEvent.repeat) return;
            if (nativeEvent.key === "Enter" || nativeEvent.key === " ") {
              nativeEvent.preventDefault();
              if (nativeEvent.key === "Enter") onEdit(event);
              else onFocusEvent(event.id);
            }
          }}>
          <EndpointGlyph />
        </g>}
      </g>;
    })}</g>
  </svg>;
}

const EventLabelText = memo(function EventLabelText({event, settings}: {event: TimelineEvent; settings: TimelineAxisSettings}) {
  return <>
    <span className="timeline-event-offset">{calloutLabel(settings, event)}</span>
    <span className="timeline-event-title">{event.title}</span>
    <span className="timeline-event-title-rule" aria-hidden="true" />
    {event.summary && <span className="timeline-event-summary">{event.summary}</span>}
  </>;
});

function EventLabels({eventById, settings, points, onEdit}: {
  eventById: ReadonlyMap<string, TimelineEvent>;
  settings: TimelineAxisSettings;
  points: readonly TimelineEventGeometry[];
  onEdit(event: TimelineEvent): void;
}) {
  return <div className="timeline-event-labels">
    {points.map(point => {
      if (!point.labelVisible) return null;
      const event = eventById.get(point.id);
      if (!event) return null;
      return <div key={event.id}
        data-growth-event={event.id} data-timeline-event-id={event.id}
        className={`timeline-event-label timeline-event-label-${point.placement}${event.important ? " timeline-event-label-important" : ""}${point.labelAlign === "right" ? " timeline-event-label-align-right" : ""}`}
        style={{transform: `translate(${point.labelLeft}px, ${point.labelTop}px)`, width: point.labelWidth,
          ...(event.color ? {"--timeline-event-color": event.color} : {})} as CSSProperties}
        data-custom-color={event.color ? "true" : undefined}
        aria-hidden="true" data-canvas-interactive
        onDoubleClick={() => onEdit(event)}>
        <EventLabelText event={event} settings={settings} />
      </div>;
    })}
  </div>;
}

function FocusedEvent({event, settings, onEdit}: {
  event: TimelineEvent;
  settings: TimelineAxisSettings;
  onEdit(event: TimelineEvent): void;
}) {
  const title = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    title.current?.focus({preventScroll: true});
  }, []);
  const offset = calloutLabel(settings, event);

  return <div className="timeline-focus-event" data-timeline-event-id={event.id} data-canvas-interactive
    style={event.color ? {"--timeline-focus-event-color": event.color} as CSSProperties : undefined}
    onDoubleClick={click => { if (click.button === 0) onEdit(event); }}>
    <span className="timeline-focus-event-offset" title={offset}>{offset}</span>
    <button ref={title} className="timeline-focus-event-title" type="button"
      aria-label={eventAccessibleName(settings, event)} aria-description="按 Enter 编辑事件。"
      title={event.title} onClick={click => { if (click.detail === 0) onEdit(event); }}>
      <span>{event.title}</span>
    </button>
    <span className="timeline-focus-event-rule" aria-hidden="true" />
    {event.summary && <p className="timeline-focus-event-excerpt" title={event.summary}>{event.summary}</p>}
  </div>;
}

export function TimelineEvents({canvas, contextMenus, assetCatalog, assetRelations = null, store, settings, view, size, axisLabelBounds, scaleTextWithZoom = false, active, openToken, growthGeometryRef, growthStemsRef, onEditingChange, onRelationFocusChange}: {
  canvas: CanvasService;
  contextMenus: ContextMenuService;
  assetCatalog: AssetCatalog | null;
  assetRelations?: AssetRelationNetwork | null;
  store: TimelineEventStore;
  settings: TimelineAxisSettings;
  view: View;
  size: Size;
  axisLabelBounds: readonly TimelineLabelBounds[];
  scaleTextWithZoom?: boolean;
  active: boolean;
  openToken?: string | null;
  growthGeometryRef?: RefObject<TimelineEventsGeometry | null>;
  growthStemsRef?: RefObject<readonly TimelineStemSegment[] | null>;
  onEditingChange?: (editing: boolean) => void;
  onRelationFocusChange?: (focused: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const formId = useId();
  const menuSurface = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const keepEventButton = useRef<HTMLButtonElement>(null);
  const onEditingChangeRef = useRef(onEditingChange);
  const editingOwnerRef = useRef<((editing: boolean) => void) | null>(null);
  const editingRef = useRef(false);
  const storeRef = useRef(store);
  const previousStoreRef = useRef(store);
  const activeRef = useRef(active);
  const previousActiveRef = useRef(active);
  storeRef.current = store;
  activeRef.current = active;
  const operationEpochRef = useRef(0);
  const operationRef = useRef<Operation | null>(null);
  const [editing, setEditing] = useState(false);
  const [formSession, setFormSession] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [eventFocus, setEventFocus] = useState<EventFocus | null>(null);
  const restoreCanvasFocus = useRef(false);

  useLayoutEffect(() => {
    if (!deleteTarget && restoreCanvasFocus.current) {
      restoreCanvasFocus.current = false;
      if (active) menuSurface.current?.focus({preventScroll: true});
    }
  }, [active, deleteTarget]);

  onEditingChangeRef.current = onEditingChange;

  useLayoutEffect(() => {
    if (previousStoreRef.current === store) return;
    previousStoreRef.current = store;
    operationEpochRef.current++;
    operationRef.current = null;
    setSubmitting(false);
    setOperationError(null);
    setDeleteTarget(null);
    setDraft(null);
    setIsNewDraft(false);
    setIsEditing(false);
  }, [store]);

  useLayoutEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    if (!active) {
      // Keep the user's draft while this canvas is hidden; stale async results must not
      // close it or overwrite the draft if the canvas becomes active again.
      operationEpochRef.current++;
      setSubmitting(false);
    }
  }, [active]);

  useLayoutEffect(() => () => {
    operationEpochRef.current++;
    if (editingRef.current) {
      editingRef.current = false;
      editingOwnerRef.current?.(false);
      editingOwnerRef.current = null;
    }
  }, []);

  function setIsEditing(next: boolean) {
    setEditing(next);
    if (editingRef.current !== next) {
      editingRef.current = next;
      if (next) {
        setFormSession(session => session + 1);
        editingOwnerRef.current = onEditingChangeRef.current ?? null;
        editingOwnerRef.current?.(true);
      } else {
        const owner = editingOwnerRef.current;
        editingOwnerRef.current = null;
        owner?.(false);
      }
    }
  }

  function beginCreate() {
    if (!active || editingRef.current || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving) return;
    setDraft({...draftFromEvent(), id: crypto.randomUUID()});
    setIsNewDraft(true);
    setOperationError(null);
    setDeleteTarget(null);
    operationRef.current = null;
    setIsEditing(true);
  }

  const openEvent = useCallback((event: TimelineEvent) => {
    if (!active || editingRef.current || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving) return;
    setDraft(draftFromEvent(event));
    setIsNewDraft(false);
    setOperationError(null);
    setDeleteTarget(null);
    operationRef.current = null;
    setIsEditing(true);
  }, [active, snapshot.loaded, snapshot.loading, snapshot.blocked, snapshot.saving]);

  function askToDelete(event: TimelineEvent, source: DeleteTarget["source"]) {
    if (!active || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving || submitting) return;
    if (source === "canvas") {
      if (editingRef.current) return;
      setDraft(null);
      setOperationError(null);
      operationRef.current = null;
      setIsEditing(true);
    }
    setDeleteTarget({id: event.id, title: event.title, source});
  }

  function cancelDraft(force = false) {
    if (!force && (submitting || snapshot.saving)) return;
    operationEpochRef.current++;
    operationRef.current = null;
    setSubmitting(false);
    setIsEditing(false);
  }

  function clearDialogContent() {
    setDraft(null);
    setIsNewDraft(false);
    setOperationError(null);
    setDeleteTarget(null);
  }

  function onDialogTransitionComplete(open: boolean) {
    if (!open && !editingRef.current) clearDialogContent();
  }

  function updateDraft(next: Partial<Draft>) {
    setOperationError(null);
    setDraft(current => current ? {...current, ...next} : current);
  }

  function keepEvent() {
    if (!deleteTarget || submitting || snapshot.saving) return;
    if (deleteTarget.source === "canvas") {
      cancelDraft();
      restoreCanvasFocus.current = true;
      clearDialogContent();
      return;
    }
    setDeleteTarget(null);
  }

  function validateDraft(value: Draft): {event: TimelineEvent | null; error: string | null} {
    const title = value.title.trim();
    const summary = value.summary;
    const offsetText = value.offset.trim();
    const offset = Number(offsetText);
    if (!title || [...title].length > 60) return {event: null, error: "事件名称需为 1–60 个字符。"};
    if ([...summary].length > 200) return {event: null, error: "事件说明不能超过 200 个字符。"};
    if (!offsetText || !Number.isFinite(offset) || Math.abs(offset) > 1_000_000_000) {
      return {event: null, error: "距故事起点的数值需为有限数字，且绝对值不超过 1,000,000,000。"};
    }
    if (value.placement !== "above" && value.placement !== "below") return {event: null, error: "请选择节点在线轴上方或下方。"};
    if (value.color && !isTimelineEventColor(value.color)) return {event: null, error: "颜色值需要使用 #RRGGBB 格式。"};
    const id = value.id;
    if (!id) return {event: null, error: "事件编号尚未准备好，请重新打开添加事件。"};
    return {event: Object.freeze({id, title, summary, offset: Object.is(offset, -0) ? 0 : offset, placement: value.placement, important: value.important, assetIds: [...value.assetIds], ...(value.color ? {color: value.color.toLowerCase()} : {})}), error: null};
  }

  async function submitEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active || !draft || !snapshot.loaded || snapshot.blocked || snapshot.saving || submitting) return;
    const validated = validateDraft(draft);
    if (!validated.event) { setOperationError(validated.error); return; }
    const nextOperation: Operation = {kind: "upsert", draft: {...draft}};
    operationRef.current = nextOperation;
    setOperationError(null);
    setSubmitting(true);
    const epoch = operationEpochRef.current;
    const operationStore = store;
    try {
      const saved = await operationStore.upsert(validated.event);
      if (epoch !== operationEpochRef.current || storeRef.current !== operationStore || !activeRef.current) return;
      if (saved) cancelDraft(true);
      else setOperationError(operationStore.getSnapshot().error ?? "事件保存失败，请重试。");
    } catch (cause) {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore && activeRef.current) {
        setOperationError(cause instanceof Error ? cause.message : "事件保存失败，请重试。");
      }
    } finally {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore) setSubmitting(false);
    }
  }

  async function removeEvent() {
    if (!active || !deleteTarget || !snapshot.loaded || snapshot.blocked || snapshot.saving || submitting) return;
    operationRef.current = {kind: "remove", id: deleteTarget.id};
    setSubmitting(true);
    setOperationError(null);
    const epoch = operationEpochRef.current;
    const operationStore = store;
    try {
      const removed = await operationStore.remove(deleteTarget.id);
      if (epoch !== operationEpochRef.current || storeRef.current !== operationStore || !activeRef.current) return;
      if (removed) cancelDraft(true);
      else setOperationError(operationStore.getSnapshot().error ?? "事件删除失败，请重试。");
    } catch (cause) {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore && activeRef.current) {
        setOperationError(cause instanceof Error ? cause.message : "事件删除失败，请重试。");
      }
    } finally {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore) setSubmitting(false);
    }
  }

  async function retryLastOperation() {
    if (!active || snapshot.loading || snapshot.saving || submitting) return;
    const operation = operationRef.current;
    const operationStore = store;
    if (!operation) {
      setSubmitting(true);
      const epoch = operationEpochRef.current;
      try {
        const loaded = await operationStore.retry();
        if (epoch === operationEpochRef.current && storeRef.current === operationStore && activeRef.current && !loaded) {
          setOperationError(operationStore.getSnapshot().error ?? "读取事件失败，请重试。");
        }
      } catch (cause) {
        if (epoch === operationEpochRef.current && storeRef.current === operationStore && activeRef.current) {
          setOperationError(cause instanceof Error ? cause.message : "读取事件失败，请重试。");
        }
      } finally {
        if (epoch === operationEpochRef.current && storeRef.current === operationStore) setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    const epoch = operationEpochRef.current;
    try {
      const saved = await operationStore.retry();
      if (epoch !== operationEpochRef.current || storeRef.current !== operationStore || !activeRef.current) return;
      if (!saved) {
        setOperationError(operationStore.getSnapshot().error ?? "事件保存失败，请重试。");
        return;
      }
      if (operation.kind === "remove") {
        const eventStillExists = operationStore.getSnapshot().events.some(event => event.id === operation.id);
        if (!eventStillExists) { cancelDraft(true); return; }
        const removed = await operationStore.remove(operation.id);
        if (epoch !== operationEpochRef.current || storeRef.current !== operationStore || !activeRef.current) return;
        if (removed) cancelDraft(true);
        else setOperationError(operationStore.getSnapshot().error ?? "事件删除失败，请重试。");
      } else {
        const latestDraft = draft ?? operation.draft;
        const validated = validateDraft(latestDraft);
        if (!validated.event) {
          setOperationError(validated.error ?? "请检查事件内容后重试。");
          return;
        }
        operationRef.current = {kind: "upsert", draft: {...latestDraft}};
        const resaved = await operationStore.upsert(validated.event);
        if (epoch !== operationEpochRef.current || storeRef.current !== operationStore || !activeRef.current) return;
        if (resaved) cancelDraft(true);
        else setOperationError(operationStore.getSnapshot().error ?? "事件保存失败，请重试。");
      }
    } catch (cause) {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore && activeRef.current) {
        setOperationError(cause instanceof Error ? cause.message : "事件保存失败，请重试。");
      }
    } finally {
      if (epoch === operationEpochRef.current && storeRef.current === operationStore) setSubmitting(false);
    }
  }

  const eventById = useMemo(() => new Map(snapshot.events.map(event => [event.id, event])), [snapshot.events]);
  const editedEvent = !isNewDraft && draft?.id ? eventById.get(draft.id) : undefined;
  const geometry = useMemo(() => getTimelineEventsGeometry({events: snapshot.events, origin: settings.origin, step: settings.step,
    center: view.center, zoom: view.zoom, width: size.width, height: size.height, axisLabelBounds, scaleTextWithZoom}),
  [snapshot.events, settings.origin, settings.step, view.center.x, view.center.y, view.zoom, size.width, size.height, axisLabelBounds, scaleTextWithZoom]);
  const stemSegments = useMemo(() => getTimelineStemSegments(geometry), [geometry]);
  const focusInView = active && eventFocus?.store === store && eventFocus.view === view && eventFocus.openToken === openToken
    ? eventFocus : null;
  const focusedEvent = focusInView && eventById.get(focusInView.id);
  const focusedPoint = focusedEvent ? geometry.events.find(point => point.id === focusedEvent.id) : undefined;
  const focusedAsset = assetRelations ? focusInView?.asset ?? null : null;
  const relationFocused = Boolean(focusedPoint && focusedAsset);
  useLayoutEffect(() => {
    if (eventFocus && !focusedPoint) setEventFocus(null);
    else if (eventFocus?.asset && !assetRelations) setEventFocus({...eventFocus, asset: null, assetClickPosition: null});
  }, [eventFocus, focusedPoint, assetRelations]);

  useLayoutEffect(() => {
    if (!relationFocused || !onRelationFocusChange) return;
    onRelationFocusChange(true);
    return () => onRelationFocusChange(false);
  }, [relationFocused, onRelationFocusChange]);

  function focusEvent(id: string) {
    if (!active || editingRef.current || !eventById.has(id) || focusInView?.id === id) return;
    setEventFocus({id, store, view, openToken});
    menuSurface.current?.focus({preventScroll: true});
  }

  function focusAsset(id: string, origin: AssetClickPosition | null) {
    if (!assetRelations || !focusedPoint) return;
    setEventFocus(current => current && !current.closing && current.asset?.id !== id
      ? {...current, asset: {id, previous: current.asset ?? null}, assetClickPosition: origin} : current);
  }

  function navigateFocus(target: TimelineFocusTarget) {
    setEventFocus(current => {
      if (!current || current.closing) return current;
      return target === "timeline" ? {...current, closing: true}
        : {...current, asset: target === "event" ? null : target, assetClickPosition: null};
    });
    if (target === "timeline") menuSurface.current?.focus({preventScroll: true});
  }

  function backFromFocus() {
    navigateFocus(focusedAsset ? focusedAsset.previous ?? "event" : "timeline");
  }

  const completeEventFocusExit = useCallback(() => {
    setEventFocus(current => current?.closing ? null : current);
  }, []);

  function handleCanvasClick(event: MouseEvent<HTMLDivElement>) {
    if (!active || !focusedPoint || relationFocused || editingRef.current || event.button !== 0 || event.ctrlKey || event.detail > 1) return;
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    if (!event.target.closest(".timeline-focus-assets [data-canvas-interactive], .timeline-focus-asset")) backFromFocus();
  }

  useLayoutEffect(() => {
    if (growthGeometryRef) growthGeometryRef.current = geometry;
    if (growthStemsRef) growthStemsRef.current = stemSegments;
    return () => {
      if (growthGeometryRef?.current === geometry) growthGeometryRef.current = null;
      if (growthStemsRef?.current === stemSegments) growthStemsRef.current = null;
    };
  }, [growthGeometryRef, growthStemsRef, geometry, stemSegments]);
  const invalidOffset = Boolean(draft?.offset.trim()) && !Number.isFinite(Number(draft?.offset));
  const offset = Number(draft?.offset ?? "");
  const validTitle = Boolean(draft?.title.trim()) && [...(draft?.title.trim() ?? "")].length <= 60;
  const invalidTitle = Boolean(draft?.title.trim()) && !validTitle;
  const validSummary = [...(draft?.summary ?? "")].length <= 200;
  const validOffset = Boolean(draft?.offset.trim()) && Number.isFinite(offset) && Math.abs(offset) <= 1_000_000_000;
  const validColor = !draft?.color || isTimelineEventColor(draft.color);
  const formValid = validTitle && validSummary && validOffset && validColor;
  const busy = submitting || snapshot.saving;
  const scale = view.zoom > 0 ? 1 / view.zoom : 1;
  const textScale = scaleTextWithZoom ? view.zoom : 1;
  const overlayStyle = {
    width: size.width,
    height: size.height,
    "--timeline-text-scale": textScale,
    transform: `translate(${view.center.x - size.width / (2 * Math.max(view.zoom, 0.0001))}px, ${view.center.y - size.height / (2 * Math.max(view.zoom, 0.0001))}px) scale(${scale})`,
  } as CSSProperties;
  const MenuRegion = contextMenus.Region;
  const menuItems = (target: EventMenuTarget): MenuEntry<EventMenuTarget>[] => {
    if (target.store !== store) return [];
    const addEvent: MenuEntry<EventMenuTarget> = {id: "add-event", label: "添加事件", icon: <Icon name="plus"/>, restoreFocus: false, onSelect: beginCreate};
    if (!target.eventId) return [addEvent];
    const event = eventById.get(target.eventId);
    if (!event) return [];
    return [
      {id: "view-event-assets", label: "查看关联资产", icon: <Icon name="assets"/>, restoreFocus: false, onSelect: () => focusEvent(event.id)},
      {id: "edit-event", label: "编辑事件", icon: <Icon name="pencil"/>, restoreFocus: false, onSelect: () => openEvent(event)},
      addEvent,
      {id: "event-menu-separator", type: "separator"},
      {id: "delete-event", label: "删除事件", icon: <Icon name="trash"/>, restoreFocus: false, onSelect: () => askToDelete(event, "canvas")},
    ];
  };

  return <>
    <MenuRegion<EventMenuTarget> label="时间线画布操作"
      disabled={!active || editing || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving}
      resolveContext={target => ({store, eventId: target?.closest("[data-timeline-event-id]")?.getAttribute("data-timeline-event-id") ?? undefined})}
      items={menuItems}>
    <div ref={menuSurface} className="timeline-events-overlay" style={overlayStyle} data-active={active}
      data-event-focused={Boolean(focusedPoint) || undefined}
      tabIndex={active ? 0 : -1} aria-label="时间线事件画布" onClick={handleCanvasClick}
      onKeyDown={event => {
        if (focusedPoint && !editingRef.current && event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          backFromFocus();
        }
      }}>
      {snapshot.loaded && geometry.width > 0 && geometry.height > 0 && <>
        <EventAxisMarkers eventById={eventById} settings={settings} geometry={geometry} stemSegments={stemSegments} centerX={view.center.x} zoom={view.zoom} textScale={textScale} active={active}
          focusedId={focusedPoint?.id ?? null} onFocusEvent={focusEvent} onEdit={openEvent} />
        <EventLabels eventById={eventById} settings={settings} points={focusedPoint ? [focusedPoint] : geometry.events}
          onEdit={openEvent} />
        {focusedEvent && focusedPoint && <TimelineFocusAssets key={focusedEvent.id} canvas={canvas}
          event={focusedEvent} catalog={assetCatalog} size={size} closing={Boolean(focusInView?.closing)}
          network={assetRelations} focusedAsset={focusedAsset} origin={focusedAsset ? focusInView?.assetClickPosition : null}
          onFocusAsset={focusAsset} onNavigate={navigateFocus} onBack={backFromFocus} onExited={completeEventFocusExit}>
          <FocusedEvent event={focusedEvent} settings={settings} onEdit={openEvent} />
        </TimelineFocusAssets>}
      </>}
      {snapshot.loading && <div className="timeline-events-feedback" role="status">正在读取时间线事件…</div>}
      {!snapshot.loading && snapshot.error && <div className="timeline-events-feedback" role="alert">
        <span>{snapshot.error}</span>
        <Button variant="ghost" disabled={!active || snapshot.loading || snapshot.saving || submitting} onClick={() => void retryLastOperation()}>重试</Button>
      </div>}
    </div>
    </MenuRegion>

    {deleteTarget && <Dialog key="delete-event" open={editing && active} onOpenChange={open => {
      if (!open && active) keepEvent();
    }} onOpenChangeComplete={onDialogTransitionComplete}
      title="删除事件" size="narrow" description="删除后会立即保存到当前项目。"
      busy={busy} initialFocus={keepEventButton} finalFocus={menuSurface}>
      <div className="timeline-event-delete-confirm">
        <p>确定删除「{deleteTarget.title}」吗？</p>
        {(operationError || snapshot.error) && <p className="timeline-event-form-error" role="alert">{operationError ?? snapshot.error}</p>}
        <DialogActions>
          {operationRef.current?.kind === "remove" && (operationError || snapshot.error)
            && <Button variant="ghost" type="button" disabled={submitting || snapshot.saving} onClick={() => void retryLastOperation()}>重试删除</Button>}
          <Button ref={keepEventButton} variant="secondary" type="button" disabled={busy} onClick={keepEvent}>保留事件</Button>
          <Button type="button" variant="danger" disabled={submitting || snapshot.saving} onClick={() => void removeEvent()}>
            {submitting ? "正在删除…" : "确认删除"}
          </Button>
        </DialogActions>
      </div>
    </Dialog>}

    {draft && !deleteTarget && <Dialog key="event-form" open={editing && active} onOpenChange={open => {
      if (!open && active && !busy) cancelDraft();
    }} onOpenChangeComplete={onDialogTransitionComplete}
      title={isNewDraft ? "添加时间线事件" : "编辑事件"} size="large" bodyLayout="flush"
      headerActions={<>
        {editedEvent && <EventActions disabled={busy} onDelete={() => askToDelete(editedEvent, "editor")} />}
        <DialogClose aria-label="关闭事件编辑" title="关闭" variant="ghost"><Icon name="close" /></DialogClose>
      </>}
      busy={busy} initialFocus={titleInput} finalFocus={menuSurface}>
      <form key={formSession} className="timeline-event-form" onSubmit={event => void submitEvent(event)}>
        <div className="timeline-event-form-scroll">
          <div className="timeline-event-form-columns">
            <div className="timeline-event-content">
              <div className="timeline-event-field">
                <label htmlFor={`${formId}-title`}>事件名称</label>
                <TextField ref={titleInput} id={`${formId}-title`} type="text" required autoComplete="off" placeholder="例如：收到故乡来信" value={draft?.title ?? ""}
                  onChange={event => updateDraft({title: event.target.value})} aria-invalid={invalidTitle || undefined}
                  aria-describedby={invalidTitle ? `${formId}-title-help` : undefined} disabled={busy}/>
                {invalidTitle && <span id={`${formId}-title-help`} className="timeline-event-form-error">事件名称需为 1–60 个字符。</span>}
              </div>
              <div className="timeline-event-field">
                <label htmlFor={`${formId}-summary`}>事件说明 <span className="timeline-event-optional">选填</span></label>
                <Textarea id={`${formId}-summary`} rows={4} placeholder="发生了什么，对故事有什么影响…" value={draft?.summary ?? ""} onChange={event => updateDraft({summary: event.target.value})}
                  aria-invalid={!validSummary || undefined} aria-describedby={`${formId}-summary-help`} disabled={busy}/>
                <span id={`${formId}-summary-help`} className={validSummary ? "timeline-event-summary-help timeline-event-field-help" : "timeline-event-summary-help timeline-event-form-error"}>
                  {validSummary ? "200 字以内" : "事件说明不能超过 200 个字符。"}
                </span>
              </div>
              {draft && <EventAssetPicker catalog={assetCatalog} selectedIds={draft.assetIds}
                disabled={busy} onChange={assetIds => updateDraft({assetIds})} />}
            </div>
            <section className="timeline-event-settings" aria-labelledby={`${formId}-axis`}>
              <h3 id={`${formId}-axis`}>时间轴</h3>
              <div className="timeline-event-field">
                <label htmlFor={`${formId}-offset`}>距故事起点</label>
                <TextField id={`${formId}-offset`} type="number" step="any" min="-1000000000" max="1000000000" required value={draft?.offset ?? ""}
                  onChange={event => updateDraft({offset: event.target.value})} aria-invalid={invalidOffset || (Boolean(draft?.offset.trim()) && !validOffset) || undefined}
                  aria-describedby={`${formId}-offset-help`} disabled={busy}/>
                <span id={`${formId}-offset-help`} className="timeline-event-field-help">{formatOffsetHint(settings, draft?.offset ?? "")}</span>
              </div>
              <fieldset className="timeline-event-placement">
                <legend>节点位置</legend>
                <div>
                  <Button variant="ghost" aria-pressed={draft?.placement === "above"}
                    disabled={busy} onClick={() => updateDraft({placement: "above"})}>轴线上方</Button>
                  <Button variant="ghost" aria-pressed={draft?.placement === "below"}
                    disabled={busy} onClick={() => updateDraft({placement: "below"})}>轴线下方</Button>
                </div>
              </fieldset>
              <div className="timeline-event-markers">
                <label className="timeline-event-important">
                  <span className="timeline-event-checkbox">
                    <input type="checkbox" checked={draft?.important ?? false} onChange={event => updateDraft({important: event.target.checked})}
                      disabled={busy}/>
                    <Icon name="check" size="small"/>
                  </span>
                  <span>关键转折</span>
                </label>
                <EventColorPicker value={draft?.color ?? ""} valid={validColor} disabled={busy}
                  onChange={color => updateDraft({color})} />
              </div>
            </section>
          </div>
        </div>
        <div className="timeline-event-form-footer">
          {(operationError || snapshot.error) && <p className="timeline-event-form-error" role="alert">{operationError ?? snapshot.error}</p>}
          <DialogActions>
            <Button variant="ghost" disabled={busy} onClick={() => cancelDraft()}>取消</Button>
            <Button type="submit" variant="primary" disabled={!formValid || busy}>
              {submitting ? "正在保存…" : snapshot.error ? "重试保存" : "保存事件"}
            </Button>
          </DialogActions>
        </div>
      </form>
    </Dialog>}
  </>;
}

export default TimelineEvents;
