import {memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type RefObject} from "react";
import type {CanvasViewportSnapshot} from "@lodestory/sdk/canvas";
import type {ContextMenuService} from "@lodestory/sdk/context-menu";
import type {AssetCatalog} from "@lodestory/sdk/asset-catalog";
import {Button, Dialog, DialogActions, Icon, TextField, Textarea} from "@lodestory/ui";
import type {TimelineAxisSettings} from "./timelineAxisStore";
import {isTimelineEventColor, type TimelineEvent, type TimelineEventStore} from "./timelineEventStore";
import {getTimelineEventsGeometry, TIMELINE_TURNING_CAPTION_FONT_SIZE, type TimelineEventsGeometry} from "./timelineEventsGeometry";
import {getTimelineStemSegments, type TimelineStemSegment} from "./timelineStemSegments";
import {formatTimelineAxisValue, timelineValueAtOffset, TIMELINE_AXIS_BASE_PIXEL_INTERVAL, type TimelineLabelBounds} from "./timelineAxisGeometry";
import {EventAssetPicker} from "./EventAssetPicker";
import "./timeline-events.css";

type Size = Readonly<{width: number; height: number}>;
type Draft = {id: string | null; title: string; summary: string; offset: string; placement: "above" | "below"; important: boolean; assetIds: readonly string[]; color: string};
type Operation = {kind: "upsert"; draft: Draft} | {kind: "remove"; id: string};

const EVENT_COLORS = [
  {name: "红色", value: "#d96666"}, {name: "橙色", value: "#d58a51"},
  {name: "黄色", value: "#c6a044"}, {name: "绿色", value: "#68a778"},
  {name: "青色", value: "#59a8a5"}, {name: "蓝色", value: "#6b9bce"},
  {name: "紫色", value: "#a489c9"}, {name: "粉色", value: "#ce83a2"},
] as const;

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
  return `${marker}：${event.title}${summary}，${calloutLabel(settings, event)}，${event.placement === "above" ? "轴线上方" : "轴线下方"}，点击编辑`;
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

const AxisAnchor = memo(function AxisAnchor({event, x, active, onEdit}: {
  event: TimelineEvent;
  x: number;
  active: boolean;
  onEdit(event: TimelineEvent): void;
}) {
  const origin = event.offset === 0;
  const markerClass = ["timeline-event-axis-marker", origin ? "timeline-event-axis-marker-origin" : "",
    event.important ? "timeline-event-axis-marker-important" : ""].filter(Boolean).join(" ");
  return <g className="timeline-event-markers" data-active={active}>
    <g className={markerClass} aria-hidden="true" data-canvas-interactive
      transform={`translate(${x} 0)`} onClick={() => { if (active) onEdit(event); }}>
      <AxisMarkerGlyph important={event.important} origin={origin} />
    </g>
  </g>;
});

/** A stable set of native hit targets; panning only translates the enclosing group. */
const AxisAnchors = memo(function AxisAnchors({events, step, zoom, originWorldX, active, onEdit}: {
  events: readonly TimelineEvent[];
  step: number;
  zoom: number;
  originWorldX: number;
  active: boolean;
  onEdit(event: TimelineEvent): void;
}) {
  const count = Math.min(24, events.length);
  return <>{Array.from({length: count}, (_, index) => {
    const group = events.slice(Math.floor(index * events.length / count), Math.floor((index + 1) * events.length / count));
    return <g key={group[0].id} data-growth-anchor={group[0].id}>{group.map(event => {
      const x = ((event.offset / step) * TIMELINE_AXIS_BASE_PIXEL_INTERVAL - originWorldX) * zoom;
      return <AxisAnchor key={event.id} event={event} x={x} active={active} onEdit={onEdit} />;
    })}</g>;
  })}</>;
});

function EventAxisMarkers({eventById, settings, geometry, stemSegments, centerX, zoom, active, onEdit}: {
  eventById: ReadonlyMap<string, TimelineEvent>;
  settings: TimelineAxisSettings;
  geometry: ReturnType<typeof getTimelineEventsGeometry>;
  stemSegments: readonly TimelineStemSegment[];
  centerX: number;
  zoom: number;
  active: boolean;
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
  return <svg className="timeline-events-svg" aria-hidden="false" width={geometry.width} height={geometry.height}
    viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
    <g className="timeline-event-stems" aria-hidden="true">
      {stems[0].length > 0 && <path className="timeline-event-stem" d={stems[0].join("")} />}
      {stems[1].length > 0 && <path className="timeline-event-stem timeline-event-stem-important" d={stems[1].join("")} />}
    </g>
    <g className="timeline-event-axis-anchors">
      <g transform={`translate(${geometry.width / 2 + (originWorldX - centerX) * zoom} ${geometry.axisY})`}>
        <AxisAnchors events={markerEvents} step={settings.step} zoom={zoom} originWorldX={originWorldX}
          active={active} onEdit={onEdit} />
      </g>
    </g>
    <g className="timeline-event-details">{geometry.events.map(point => {
      if (!point.endpointVisible && !point.turningCaptionVisible) return null;
      const event = eventById.get(point.id);
      if (!event) return null;
      const originEvent = event.offset === 0;
      return <g key={event.id} data-growth-event={event.id}>
        {point.turningCaptionVisible && point.turningCaption && <g className="timeline-event-axis-marker"
          aria-hidden="true" data-canvas-interactive transform={`translate(${point.x} ${point.axisY})`}
          onClick={() => { if (active) onEdit(event); }}>
          <text className="timeline-event-turning-caption"
            x={point.turningCaption.left + point.turningCaption.width / 2 - point.x} y={point.turningCaption.top - point.axisY}
            fontSize={TIMELINE_TURNING_CAPTION_FONT_SIZE} textAnchor="middle" dominantBaseline="hanging">关键转折</text>
        </g>}
        {point.endpointVisible && <g className={["timeline-event-endpoint", originEvent ? "timeline-event-endpoint-origin" : "",
          event.important ? "timeline-event-endpoint-important" : ""].filter(Boolean).join(" ")}
          style={event.color ? {"--timeline-event-color": event.color} as CSSProperties : undefined}
          data-custom-color={event.color ? "true" : undefined}
          role="button" tabIndex={active ? 0 : -1}
          aria-label={eventAccessibleName(settings, event)} aria-disabled={!active}
          data-canvas-interactive transform={`translate(${point.x} ${point.endpointY})`}
          onClick={() => { if (active) onEdit(event); }}
          onKeyDown={nativeEvent => {
            if ((nativeEvent.key === "Enter" || nativeEvent.key === " ") && active) {
              nativeEvent.preventDefault();
              onEdit(event);
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

function EventLabels({eventById, settings, geometry, onEdit}: {
  eventById: ReadonlyMap<string, TimelineEvent>;
  settings: TimelineAxisSettings;
  geometry: ReturnType<typeof getTimelineEventsGeometry>;
  onEdit(event: TimelineEvent): void;
}) {
  return <div className="timeline-event-labels">
    {geometry.events.map(point => {
      if (!point.labelVisible) return null;
      const event = eventById.get(point.id);
      if (!event) return null;
      return <div key={event.id}
        data-growth-event={event.id}
        className={`timeline-event-label timeline-event-label-${point.placement}${event.important ? " timeline-event-label-important" : ""}${point.labelAlign === "right" ? " timeline-event-label-align-right" : ""}`}
        style={{transform: `translate(${point.labelLeft}px, ${point.labelTop}px)`, width: point.labelWidth,
          ...(event.color ? {"--timeline-event-color": event.color} : {})} as CSSProperties}
        data-custom-color={event.color ? "true" : undefined}
        aria-hidden="true" data-canvas-interactive
        onClick={() => onEdit(event)}>
        <EventLabelText event={event} settings={settings} />
      </div>;
    })}
  </div>;
}

export function TimelineEvents({contextMenus, assetCatalog, store, settings, view, size, axisLabelBounds, active, growthGeometryRef, growthStemsRef, onEditingChange}: {
  contextMenus: ContextMenuService;
  assetCatalog: AssetCatalog | null;
  store: TimelineEventStore;
  settings: TimelineAxisSettings;
  view: Pick<CanvasViewportSnapshot, "center" | "zoom">;
  size: Size;
  axisLabelBounds: readonly TimelineLabelBounds[];
  active: boolean;
  growthGeometryRef?: RefObject<TimelineEventsGeometry | null>;
  growthStemsRef?: RefObject<readonly TimelineStemSegment[] | null>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const formId = useId();
  const menuSurface = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  onEditingChangeRef.current = onEditingChange;

  useLayoutEffect(() => {
    if (previousStoreRef.current === store) return;
    previousStoreRef.current = store;
    operationEpochRef.current++;
    operationRef.current = null;
    setSubmitting(false);
    setOperationError(null);
    setConfirmDelete(false);
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
    setConfirmDelete(false);
    operationRef.current = null;
    setIsEditing(true);
  }

  const beginEdit = useCallback((event: TimelineEvent) => {
    if (!active || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving) return;
    setDraft(draftFromEvent(event));
    setIsNewDraft(false);
    setOperationError(null);
    setConfirmDelete(false);
    operationRef.current = null;
    setIsEditing(true);
  }, [active, snapshot.loaded, snapshot.loading, snapshot.blocked, snapshot.saving]);

  function cancelDraft(force = false) {
    if (!force && (submitting || snapshot.saving)) return;
    operationEpochRef.current++;
    operationRef.current = null;
    setSubmitting(false);
    setDraft(null);
    setIsNewDraft(false);
    setOperationError(null);
    setConfirmDelete(false);
    setIsEditing(false);
  }

  function updateDraft(next: Partial<Draft>) {
    setOperationError(null);
    setDraft(current => current ? {...current, ...next} : current);
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
    if (!active || !draft?.id || !snapshot.loaded || snapshot.blocked || snapshot.saving || submitting) return;
    operationRef.current = {kind: "remove", id: draft.id};
    setSubmitting(true);
    setOperationError(null);
    const epoch = operationEpochRef.current;
    const operationStore = store;
    try {
      const removed = await operationStore.remove(draft.id);
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
  const geometry = useMemo(() => getTimelineEventsGeometry({events: snapshot.events, origin: settings.origin, step: settings.step,
    center: view.center, zoom: view.zoom, width: size.width, height: size.height, axisLabelBounds}),
  [snapshot.events, settings.origin, settings.step, view.center.x, view.center.y, view.zoom, size.width, size.height, axisLabelBounds]);
  const stemSegments = useMemo(() => getTimelineStemSegments(geometry), [geometry]);
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
  const validSummary = [...(draft?.summary ?? "")].length <= 200;
  const validOffset = Boolean(draft?.offset.trim()) && Number.isFinite(offset) && Math.abs(offset) <= 1_000_000_000;
  const validColor = !draft?.color || isTimelineEventColor(draft.color);
  const formValid = validTitle && validSummary && validOffset && validColor;
  const scale = view.zoom > 0 ? 1 / view.zoom : 1;
  const overlayStyle = {
    width: size.width,
    height: size.height,
    transform: `translate(${view.center.x - size.width / (2 * Math.max(view.zoom, 0.0001))}px, ${view.center.y - size.height / (2 * Math.max(view.zoom, 0.0001))}px) scale(${scale})`,
  };
  const MenuRegion = contextMenus.Region;

  return <>
    <MenuRegion context={store} label="时间线画布操作" disabled={!active || editing || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving}
      items={target => target === store
        ? [{id: "add-event", label: "添加事件", icon: <Icon name="plus"/>, restoreFocus: false, onSelect: beginCreate}]
        : []}>
    <div ref={menuSurface} className="timeline-events-overlay" style={overlayStyle} data-active={active}
      tabIndex={active ? 0 : -1} aria-label="时间线事件画布">
      {snapshot.loaded && geometry.width > 0 && geometry.height > 0 && <>
        <EventAxisMarkers eventById={eventById} settings={settings} geometry={geometry} stemSegments={stemSegments} centerX={view.center.x} zoom={view.zoom} active={active}
          onEdit={beginEdit} />
        <EventLabels eventById={eventById} settings={settings} geometry={geometry}
          onEdit={beginEdit} />
      </>}
      {snapshot.loading && <div className="timeline-events-feedback" role="status">正在读取时间线事件…</div>}
      {!snapshot.loading && snapshot.error && <div className="timeline-events-feedback" role="alert">
        <span>{snapshot.error}</span>
        <Button variant="ghost" disabled={!active || snapshot.loading || snapshot.saving || submitting} onClick={() => void retryLastOperation()}>重试</Button>
      </div>}
    </div>
    </MenuRegion>

    <Dialog open={editing && active} onOpenChange={open => {
      if (open) return;
      if (active && !submitting && !snapshot.saving) cancelDraft();
    }} title={confirmDelete ? "删除事件" : !isNewDraft && draft?.id ? "编辑事件" : "添加时间线事件"} size={confirmDelete ? "narrow" : "regular"}
      description={confirmDelete ? "删除后会立即保存到当前项目。" : "记录故事中的重要时刻。"}
      busy={submitting || snapshot.saving} initialFocus={titleInput}
      finalFocus={menuSurface}>
      {confirmDelete ? <div className="timeline-event-delete-confirm">
        <p>确定删除「{draft?.title || "未命名事件"}」吗？</p>
        {(operationError || snapshot.error) && <p className="timeline-event-form-error" role="alert">{operationError ?? snapshot.error}</p>}
        <DialogActions>
          {operationRef.current?.kind === "remove" && (operationError || snapshot.error)
            && <Button variant="ghost" type="button" disabled={submitting || snapshot.saving} onClick={() => void retryLastOperation()}>重试删除</Button>}
          <Button variant="secondary" type="button" disabled={submitting || snapshot.saving} onClick={() => setConfirmDelete(false)}>保留事件</Button>
          <Button type="button" variant="danger" disabled={submitting || snapshot.saving} onClick={() => void removeEvent()}>
            {submitting ? "正在删除…" : "确认删除"}
          </Button>
        </DialogActions>
      </div> : <form className="timeline-event-form" onSubmit={event => void submitEvent(event)}>
        <div className="timeline-event-field">
          <div className="timeline-event-field-heading">
            <label htmlFor={`${formId}-title`}>事件名称</label>
            <span id={`${formId}-title-count`} className="timeline-event-field-count">{[...(draft?.title.trim() ?? "")].length} / 60</span>
          </div>
          <TextField ref={titleInput} id={`${formId}-title`} type="text" required autoComplete="off" placeholder="例如：收到故乡来信" value={draft?.title ?? ""}
            onChange={event => updateDraft({title: event.target.value})} aria-invalid={Boolean(draft?.title.trim()) && !validTitle || undefined}
            aria-describedby={`${formId}-title-count`} disabled={submitting || snapshot.saving}/>
        </div>
        <div className="timeline-event-position-row">
          <label className="timeline-event-field"><span>距故事起点</span>
            <TextField type="number" step="any" min="-1000000000" max="1000000000" required value={draft?.offset ?? ""}
              onChange={event => updateDraft({offset: event.target.value})} aria-invalid={invalidOffset || (Boolean(draft?.offset.trim()) && !validOffset) || undefined}
              aria-describedby={`${formId}-offset-help`} disabled={submitting || snapshot.saving}/>
            <span id={`${formId}-offset-help`} className="timeline-event-field-help">{formatOffsetHint(settings, draft?.offset ?? "")}</span>
          </label>
          <fieldset className="timeline-event-placement">
            <legend>节点位置</legend>
            <div role="group" aria-label="节点位置">
              <Button type="button" variant="ghost" aria-pressed={draft?.placement === "above"}
                disabled={submitting || snapshot.saving} onClick={() => updateDraft({placement: "above"})}>轴线上方</Button>
              <Button type="button" variant="ghost" aria-pressed={draft?.placement === "below"}
                disabled={submitting || snapshot.saving} onClick={() => updateDraft({placement: "below"})}>轴线下方</Button>
            </div>
          </fieldset>
        </div>
        <div className="timeline-event-field">
          <div className="timeline-event-field-heading">
            <label htmlFor={`${formId}-summary`}>事件说明 <span className="timeline-event-optional">选填</span></label>
            <span id={`${formId}-summary-count`} className="timeline-event-field-count">{[...(draft?.summary ?? "")].length} / 200</span>
          </div>
          <Textarea id={`${formId}-summary`} rows={3} placeholder="发生了什么，对故事有什么影响…" value={draft?.summary ?? ""} onChange={event => updateDraft({summary: event.target.value})}
            aria-invalid={!validSummary || undefined} aria-describedby={`${formId}-summary-count`} disabled={submitting || snapshot.saving}/>
        </div>
        <label className="timeline-event-important">
          <span className="timeline-event-checkbox">
            <input type="checkbox" checked={draft?.important ?? false} onChange={event => updateDraft({important: event.target.checked})}
              disabled={submitting || snapshot.saving}/>
            <Icon name="check" size="small"/>
          </span>
          <span>标记为关键转折</span>
        </label>
        <fieldset className="timeline-event-color-picker" disabled={submitting || snapshot.saving}>
          <legend>颜色标记 <span className="timeline-event-optional">选填</span></legend>
          <div className="timeline-event-color-options">
            <label className="timeline-event-color-choice timeline-event-color-default">
              <input type="radio" name={`${formId}-color`} checked={!draft?.color} onChange={() => updateDraft({color: ""})}/>
              <span>默认</span>
            </label>
            {EVENT_COLORS.map(color => <label className="timeline-event-color-choice" key={color.value} title={`${color.name} ${color.value.toUpperCase()}`}>
              <input type="radio" name={`${formId}-color`} aria-label={color.name} checked={draft?.color.toLowerCase() === color.value}
                onChange={() => updateDraft({color: color.value})}/>
              <span style={{"--timeline-event-swatch": color.value} as CSSProperties}/>
            </label>)}
          </div>
          <div className="timeline-event-color-custom">
            <label>自定义 <input type="color" aria-label="自定义颜色" value={isTimelineEventColor(draft?.color) ? draft.color : "#6b9bce"}
              onChange={event => updateDraft({color: event.currentTarget.value})}/></label>
            <TextField aria-label="颜色值" aria-describedby={`${formId}-color-help`} aria-invalid={!validColor || undefined}
              autoComplete="off" spellCheck={false} placeholder="#RRGGBB" maxLength={7} value={draft?.color ?? ""}
              onChange={event => updateDraft({color: event.currentTarget.value})}/>
          </div>
          <p id={`${formId}-color-help`} className="timeline-event-field-help">用于标记事件端点和标题短线，输入 #RRGGBB；清空或选择默认可移除。</p>
        </fieldset>
        {draft && <EventAssetPicker catalog={assetCatalog} selectedIds={draft.assetIds}
          disabled={submitting || snapshot.saving} onChange={assetIds => updateDraft({assetIds})} />}
        {(operationError || snapshot.error) && <p className="timeline-event-form-error" role="alert">{operationError ?? snapshot.error}</p>}
        <DialogActions>
          {draft?.id && !isNewDraft && <Button type="button" variant="danger" disabled={submitting || snapshot.saving} onClick={() => setConfirmDelete(true)}>删除事件</Button>}
          <Button type="button" variant="ghost" disabled={submitting || snapshot.saving} onClick={() => cancelDraft()}>取消</Button>
          <Button type="submit" variant="primary" disabled={!formValid || submitting || snapshot.saving}>
            {submitting || snapshot.saving ? "正在保存…" : snapshot.error ? "重试保存" : "保存事件"}
          </Button>
        </DialogActions>
      </form>}
    </Dialog>
  </>;
}

export default TimelineEvents;
