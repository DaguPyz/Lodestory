import {useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import type {CanvasService, CanvasViewport} from "@lodestory/sdk/canvas";
import type {ContextMenuService} from "@lodestory/sdk/context-menu";
import type {AssetCatalog} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationNetwork} from "@lodestory/sdk/asset-relations";
import {Button, Dialog, DialogActions, TextField} from "@lodestory/ui";
import type {TimelineAxisStore, TimelineAxisSettings} from "./timelineAxisStore";
import type {TimelineEventStore} from "./timelineEventStore";
import {TimelineEvents} from "./TimelineEvents";
import {TimelineTextZoomSwitch} from "./TimelineTextZoomSwitch";
import type {TimelineEventsGeometry} from "./timelineEventsGeometry";
import {getStemSegmentTiming, type TimelineStemSegment} from "./timelineStemSegments";
import {formatTimelineAxisValue, getTimelineAxisGeometry, TIMELINE_AXIS_LABEL_LAYOUT, type TimelineAxisTick} from "./timelineAxisGeometry";

type Draft = {origin: string; step: string; unit: string};
type Size = {width: number; height: number};

export function createTimelineCanvasView(viewport: CanvasViewport) {
  let scaleTextWithZoom = false;
  const listeners = new Set<() => void>();
  return {
    viewport,
    getScaleTextWithZoom: () => scaleTextWithZoom,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setScaleTextWithZoom(enabled: boolean) {
      if (enabled === scaleTextWithZoom || viewport.getSnapshot().disposed) return;
      scaleTextWithZoom = enabled;
      for (const listener of [...listeners]) listener();
    },
    dispose() {
      listeners.clear();
      viewport.dispose();
    },
  };
}

function draftFromSettings(settings: TimelineAxisSettings): Draft {
  return {origin: String(settings.origin), step: String(settings.step), unit: settings.unit};
}

function draftIsDirty(draft: Draft | null, settings: TimelineAxisSettings): boolean {
  if (!draft) return false;
  const origin = Number(draft.origin);
  const step = Number(draft.step);
  return !Number.isFinite(origin) || !Number.isFinite(step)
    || origin !== settings.origin || step !== settings.step || draft.unit !== settings.unit;
}

function AxisTicks({ticks, axisY, worldHalfWidth, zoom}: {ticks: readonly TimelineAxisTick[]; axisY: number; worldHalfWidth: number; zoom: number}) {
  const layout = TIMELINE_AXIS_LABEL_LAYOUT;
  return <><g className="timeline-axis-ticks">
    {ticks.map(tick => {
      const x = (tick.x + worldHalfWidth) * zoom;
      return <line key={tick.key} data-axis-tick-key={tick.key}
        className={tick.origin ? "timeline-axis-tick timeline-axis-tick-origin" : "timeline-axis-tick"}
        x1={x} x2={x} y1={axisY} y2={axisY + (tick.origin ? 16 : tick.major ? 14 : 8)}/>;
    })}
  </g><g className="timeline-axis-labels">
    {ticks.filter(tick => tick.labelVisible).map(tick => {
      const x = (tick.x + worldHalfWidth) * zoom;
      return <g key={tick.key} data-axis-tick-key={tick.key}>
          <text className={tick.origin ? "timeline-axis-label timeline-axis-label-origin" : "timeline-axis-label"}
            x={x} y={axisY + layout.valueTop} fontSize={layout.valueFontSize} textAnchor="middle" dominantBaseline="hanging">
            {formatTimelineAxisValue(tick.value)}
          </text>
          {tick.origin && <text className="timeline-axis-origin-caption" x={x} y={axisY + layout.originTop}
            fontSize={layout.originFontSize} textAnchor="middle" dominantBaseline="hanging">故事起点</text>}
      </g>;
    })}
  </g></>;
}

export function TimelineCanvas({canvas, contextMenus, assetCatalog, assetRelations = null, canvasView, active, title, axis, events, openToken = null, onEditingChange}: {
  canvas: CanvasService;
  contextMenus: ContextMenuService;
  assetCatalog: AssetCatalog | null;
  assetRelations?: AssetRelationNetwork | null;
  canvasView: ReturnType<typeof createTimelineCanvasView>;
  active: boolean;
  title: string;
  axis: TimelineAxisStore;
  events: TimelineEventStore;
  openToken?: string | null;
  onEditingChange?: (editing: boolean) => void;
}) {
  const {viewport, getScaleTextWithZoom} = canvasView;
  const snapshot = useSyncExternalStore(axis.subscribe, axis.getSnapshot, axis.getSnapshot);
  const eventSnapshot = useSyncExternalStore(events.subscribe, events.getSnapshot, events.getSnapshot);
  const view = useSyncExternalStore(viewport.subscribe, viewport.getSnapshot, viewport.getSnapshot);
  const scaleTextWithZoom = useSyncExternalStore(canvasView.subscribe, getScaleTextWithZoom, getScaleTextWithZoom);
  const frame = useRef<HTMLDivElement>(null);
  const growthGeometry = useRef<TimelineEventsGeometry | null>(null);
  const growthStems = useRef<readonly TimelineStemSegment[] | null>(null);
  const growthClipId = `timeline-growth-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const axisLine = useRef<SVGLineElement>(null);
  const handledOpen = useRef<string | null>(null);
  const stopGrowth = useRef<(() => void) | null>(null);
  const originInput = useRef<HTMLInputElement>(null);
  const onEditingChangeRef = useRef(onEditingChange);
  const editingOwnerRef = useRef<((editing: boolean) => void) | null>(null);
  const editingRef = useRef(false);
  const eventEditingRef = useRef(false);
  const resourcesRef = useRef({viewport, axis, events});
  const operationEpochRef = useRef(0);
  const [size, setSize] = useState<Size>({width: 0, height: 0});
  const [editing, setEditing] = useState(false);
  const [eventEditing, setEventEditing] = useState(false);
  const [relationFocused, setRelationFocused] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  onEditingChangeRef.current = onEditingChange;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize(current => current.width === rect.width && current.height === rect.height
        ? current : {width: rect.width, height: rect.height});
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => () => {
    operationEpochRef.current++;
    if (editingRef.current || eventEditingRef.current) {
      editingRef.current = false;
      eventEditingRef.current = false;
      editingOwnerRef.current?.(false);
      editingOwnerRef.current = null;
    }
  }, []);

  function setIsEditing(next: boolean) {
    setEditing(next);
    const wasEditing = editingRef.current || eventEditingRef.current;
    editingRef.current = next;
    updateEditingOwner(wasEditing);
  }

  function setIsEventEditing(next: boolean) {
    setEventEditing(next);
    const wasEditing = editingRef.current || eventEditingRef.current;
    eventEditingRef.current = next;
    updateEditingOwner(wasEditing);
  }

  function updateEditingOwner(wasEditing: boolean) {
    const isEditing = editingRef.current || eventEditingRef.current;
    if (wasEditing !== isEditing) {
      if (isEditing) {
        editingOwnerRef.current = onEditingChangeRef.current ?? null;
        editingOwnerRef.current?.(true);
      } else {
        const owner = editingOwnerRef.current;
        editingOwnerRef.current = null;
        owner?.(false);
      }
    }
  }

  useLayoutEffect(() => {
    const resourcesChanged = resourcesRef.current.viewport !== viewport || resourcesRef.current.axis !== axis
      || resourcesRef.current.events !== events;
    resourcesRef.current = {viewport, axis, events};
    if (resourcesChanged) {
      operationEpochRef.current++;
      setSubmitting(false);
      setOperationError(null);
      if (editingRef.current || draft) discardDraft();
    }
  }, [viewport, axis, events, draft]);

  function beginEditing() {
    if (!active || eventEditingRef.current || !snapshot.loaded || snapshot.blocked || snapshot.loading) return;
    setDraft(draftFromSettings(snapshot.settings));
    setOperationError(null);
    setIsEditing(true);
  }

  function discardDraft() {
    setDraft(null);
    setOperationError(null);
    setIsEditing(false);
  }

  async function retrySettings() {
    if (!active || snapshot.loading || snapshot.saving || submitting) return;
    const epoch = operationEpochRef.current;
    setSubmitting(true);
    setOperationError(null);
    try {
      const saved = await axis.retry();
      if (epoch !== operationEpochRef.current) return;
      if (saved && editingRef.current && draft && !draftIsDirty(draft, axis.getSnapshot().settings)) discardDraft();
      else if (!saved) setOperationError(axis.getSnapshot().error ?? "时间轴设置保存失败，请重试。");
    } catch (error) {
      if (epoch !== operationEpochRef.current) return;
      setOperationError(error instanceof Error ? error.message : "时间轴设置保存失败，请重试。");
    } finally {
      if (epoch === operationEpochRef.current) setSubmitting(false);
    }
  }

  async function saveDraft() {
    if (!draft || snapshot.saving || submitting) return;
    const originText = draft.origin.trim();
    const stepText = draft.step.trim();
    const origin = Number(originText);
    const step = Number(stepText);
    const unit = draft.unit.trim();
    const unitLength = [...unit].length;
    if (!originText || !stepText || !Number.isFinite(origin) || Math.abs(origin) > 1_000_000_000
      || !Number.isFinite(step) || step < 0.000001 || step > 1_000_000_000
      || unitLength < 1 || unitLength > 20 || /[\u0000-\u001f\u007f-\u009f]/u.test(unit)) {
      setOperationError("请检查起点数值、刻度间隔和单位范围。");
      return;
    }
    setOperationError(null);
    setSubmitting(true);
    const epoch = operationEpochRef.current;
    try {
      if (draftIsDirty(draft, snapshot.settings)) {
        const target: TimelineAxisSettings = {origin, step, unit};
        const accepted = await axis.update(target);
        if (epoch !== operationEpochRef.current) return;
        if (accepted) {
          discardDraft();
          return;
        }
        const latest = axis.getSnapshot();
        setOperationError(latest.error ?? "时间轴设置未能保存，请重试。");
        return;
      } else if (!snapshot.error) {
        return;
      }

      // A failed create may already contain the draft settings in the store snapshot.
      const saved = await axis.retry();
      if (epoch !== operationEpochRef.current) return;
      if (saved) discardDraft();
      else setOperationError(axis.getSnapshot().error ?? "时间轴设置保存失败，请重试。");
    } catch (error) {
      if (epoch !== operationEpochRef.current) return;
      setOperationError(error instanceof Error ? error.message : "时间轴设置未能保存，请重试。");
    } finally {
      if (epoch === operationEpochRef.current) setSubmitting(false);
    }
  }

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveDraft();
  }

  const geometry = getTimelineAxisGeometry({
    center: view.center,
    zoom: view.zoom,
    width: size.width,
    height: size.height,
    settings: snapshot.settings,
  });
  const worldHalfWidth = geometry.worldWidth / 2;
  const axisScreenY = size.height / 2 + geometry.axisY * view.zoom;
  const axisVisible = axisScreenY >= 0 && axisScreenY <= size.height;
  const axisReady = snapshot.loaded && geometry.width > 0 && geometry.height > 0;
  const eventsReady = eventSnapshot.loaded || (!eventSnapshot.loading && Boolean(eventSnapshot.error));

  useLayoutEffect(() => {
    if (!openToken || !active || !axisReady || !eventsReady || handledOpen.current === openToken) return;
    handledOpen.current = openToken;
    const line = axisLine.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!axisVisible || !line || motion.matches || document.documentElement.dataset.uiMotion === "reduce"
      || typeof line.animate !== "function") return;
    const style = getComputedStyle(line);
    const duration = Number.parseFloat(style.getPropertyValue("--timeline-axis-growth-duration"));
    const tickStageDuration = Number.parseFloat(style.getPropertyValue("--timeline-axis-tick-stage-duration"));
    const labelStageDuration = Number.parseFloat(style.getPropertyValue("--timeline-axis-label-stage-duration"));
    const axisMarkDuration = Number.parseFloat(style.getPropertyValue("--timeline-axis-mark-duration"));
    const branchDuration = Number.parseFloat(style.getPropertyValue("--timeline-branch-growth-duration"));
    const branchRevealDuration = Number.parseFloat(style.getPropertyValue("--timeline-branch-reveal-duration"));
    const eventAppearDuration = Number.parseFloat(style.getPropertyValue("--timeline-event-appear-duration"));
    const textAppearDuration = Number.parseFloat(style.getPropertyValue("--timeline-text-appear-duration"));
    if (![duration, tickStageDuration, labelStageDuration, axisMarkDuration, branchDuration, branchRevealDuration, eventAppearDuration, textAppearDuration].every(value => Number.isFinite(value) && value > 0)) return;
    const labels = frame.current?.querySelector<HTMLDivElement>(".timeline-event-labels");
    const descriptions = labels?.querySelectorAll<HTMLSpanElement>(".timeline-event-summary") ?? [];
    // Extremely dense views fall back to the complete static state instead of
    // starting an unbounded number of independent text animations.
    if (descriptions.length > 64 || (growthStems.current?.length ?? 0) > 128) return;

    const axisAnimation = line.animate([{transform: "scaleX(0)"}, {transform: "scaleX(1)"}], {
      duration, easing: "cubic-bezier(.2, 0, 0, 1)",
    });
    const animations = [axisAnimation];
    const axisClips: SVGClipPathElement[] = [];
    const axisGroups: SVGGElement[] = [];
    const axisDefs = line.ownerSVGElement?.querySelector("defs");
    const nodeDelay = duration + tickStageDuration + labelStageDuration;
    if (axisDefs && line.ownerSVGElement) {
      const svgNamespace = "http://www.w3.org/2000/svg";
      const axisSvg = line.ownerSVGElement;
      function revealAxisColumns(selector: string, id: string, xs: number[], top: number, bottom: number,
        delay: number, stageDuration: number) {
        const target = axisSvg.querySelector<SVGGElement>(selector);
        if (!target || !xs.length) return;
        const axisClip = document.createElementNS(svgNamespace, "clipPath");
        axisClip.id = `${growthClipId}-${id}`;
        axisClip.setAttribute("clipPathUnits", "userSpaceOnUse");
        axisDefs!.append(axisClip);
        axisClips.push(axisClip);
        axisGroups.push(target);
        target.setAttribute("clip-path", `url(#${axisClip.id})`);
        const count = Math.min(24, xs.length);
        const columns = Array.from({length: count}, (_, index) => xs
          .slice(Math.floor(index * xs.length / count), Math.floor((index + 1) * xs.length / count)));
        const revealDuration = Math.min(axisMarkDuration, stageDuration);
        const spread = stageDuration - revealDuration;
        columns.forEach((column, index) => {
          const previous = columns[index - 1];
          const next = columns[index + 1];
          const left = previous ? (previous[previous.length - 1] + column[0]) / 2 : -32;
          const right = next ? (column[column.length - 1] + next[0]) / 2 : geometry.width + 32;
          const rect = document.createElementNS(svgNamespace, "rect");
          rect.setAttribute("x", String(left)); rect.setAttribute("y", String(top));
          rect.setAttribute("width", String(right - left)); rect.setAttribute("height", String(bottom - top));
          rect.style.transformOrigin = `0px ${bottom}px`;
          axisClip.append(rect);
          animations.push(rect.animate([{transform: "scaleY(0)"}, {transform: "scaleY(1)"}], {
            delay: delay + (count > 1 ? spread * index / (count - 1) : 0),
            duration: revealDuration, easing: "cubic-bezier(0, .55, .45, 1)", fill: "backwards",
          }));
        });
      }
      const xOf = (tick: TimelineAxisTick) => (tick.x + worldHalfWidth) * view.zoom;
      revealAxisColumns(".timeline-axis-ticks", "ticks", geometry.ticks.map(xOf), axisScreenY - 2, axisScreenY + 18,
        duration, tickStageDuration);
      revealAxisColumns(".timeline-axis-labels", "labels", geometry.ticks.filter(tick => tick.labelVisible).map(xOf),
        axisScreenY + TIMELINE_AXIS_LABEL_LAYOUT.valueTop - 2,
        axisScreenY + TIMELINE_AXIS_LABEL_LAYOUT.originTop + TIMELINE_AXIS_LABEL_LAYOUT.originHeight + 2,
        duration + tickStageDuration, labelStageDuration);
    }
    const eventsSvg = frame.current?.querySelector<SVGSVGElement>(".timeline-events-svg");
    const stems = eventsSvg?.querySelector<SVGGElement>(".timeline-event-stems");
    const anchors = eventsSvg?.querySelector<SVGGElement>(".timeline-event-axis-anchors");
    const points = growthGeometry.current?.events ?? [];
    const stemSegments = growthStems.current ?? [];
    let animatedStems: SVGGElement | undefined;
    const previousStemVisibility = stems?.style.visibility ?? "";
    if (eventSnapshot.loaded && points.length && eventsSvg && labels && stems) {
      // Group nearby columns only when necessary, keeping the reveal bounded.
      const columns: typeof points[number][][] = [];
      for (const point of points) {
        const last = columns[columns.length - 1];
        if (last && Math.abs(last[0].x - point.x) < 0.01) last.push(point);
        else columns.push([point]);
      }
      const groupCount = Math.min(24, columns.length);
      const groups = Array.from({length: groupCount}, (_, index) => columns
        .slice(Math.floor(index * columns.length / groupCount), Math.floor((index + 1) * columns.length / groupCount)).flat());
      const revealDuration = Math.min(branchRevealDuration, branchDuration);
      const spread = branchDuration - revealDuration;
      const groupById = new Map<string, number>();
      for (let index = 0; index < groups.length; index++) {
        for (const point of groups[index]) groupById.set(point.id, index);
      }
      const groupDelay = (index: number) => nodeDelay + (groups.length > 1 ? spread * index / (groups.length - 1) : 0);
      animatedStems = document.createElementNS("http://www.w3.org/2000/svg", "g");
      animatedStems.classList.add("timeline-event-stems-growth");
      animatedStems.setAttribute("aria-hidden", "true");
      eventsSvg.insertBefore(animatedStems, anchors ?? null);
      stems.style.visibility = "hidden";
      for (const segment of stemSegments) {
        const index = groupById.get(segment.id);
        if (index === undefined) continue;
        const piece = document.createElementNS("http://www.w3.org/2000/svg", "line");
        piece.classList.add("timeline-event-stem");
        if (segment.important) piece.classList.add("timeline-event-stem-important");
        piece.setAttribute("x1", String(segment.x)); piece.setAttribute("x2", String(segment.x));
        piece.setAttribute("y1", String(segment.y1)); piece.setAttribute("y2", String(segment.y2));
        piece.setAttribute("pathLength", "1");
        piece.setAttribute("stroke-dasharray", "1 1");
        piece.setAttribute("data-growth-event", segment.id);
        animatedStems.append(piece);
        const timing = getStemSegmentTiming(segment.start, segment.end);
        animations.push(piece.animate([{strokeDashoffset: "1"}, {strokeDashoffset: "0"}], {
          delay: groupDelay(index) + revealDuration * timing.start,
          duration: Math.max(0.01, revealDuration * (timing.end - timing.start)), easing: timing.easing, fill: "backwards",
        }));
      }
      for (const group of anchors?.querySelectorAll<SVGGElement>("[data-growth-anchor]") ?? []) {
        const index = groupById.get(group.dataset.growthAnchor ?? "");
        if (index === undefined) continue;
        animations.push(group.animate([{opacity: 0}, {opacity: 1}], {
          delay: groupDelay(index), duration: eventAppearDuration,
          easing: "cubic-bezier(.2, 0, 0, 1)", fill: "backwards",
        }));
      }
      const details = [...eventsSvg.querySelectorAll<SVGGElement>(".timeline-event-details [data-growth-event]"),
        ...labels.querySelectorAll<HTMLDivElement>("[data-growth-event]")];
      if (details.length <= 128) {
        for (const element of details) {
          const index = groupById.get(element.dataset.growthEvent ?? "");
          if (index === undefined) continue;
          animations.push(element.animate([{opacity: 0}, {opacity: 1}], {
            delay: nodeDelay + revealDuration + (groups.length > 1 ? spread * index / (groups.length - 1) : 0),
            duration: element instanceof HTMLDivElement ? textAppearDuration : eventAppearDuration,
            easing: "cubic-bezier(.2, 0, 0, 1)", fill: "backwards",
          }));
        }
      } else {
        // Avoid creating hundreds of detail animations in unusually dense views.
        const detailGroup = eventsSvg.querySelector<SVGGElement>(".timeline-event-details");
        for (const element of [labels, detailGroup]) {
          if (element) animations.push(element.animate([{opacity: 0}, {opacity: 1}], {
            delay: nodeDelay + branchDuration, duration: element === labels ? textAppearDuration : eventAppearDuration,
            easing: "cubic-bezier(.2, 0, 0, 1)", fill: "backwards",
          }));
        }
      }
      for (const description of descriptions) {
        const label = description.closest<HTMLDivElement>("[data-growth-event]");
        const index = groupById.get(label?.dataset.growthEvent ?? "");
        if (index === undefined) continue;
        const titleDelay = details.length <= 128
          ? nodeDelay + revealDuration + (groups.length > 1 ? spread * index / (groups.length - 1) : 0)
          : nodeDelay + branchDuration;
        animations.push(description.animate([{opacity: 0}, {opacity: 1}], {
          delay: titleDelay + textAppearDuration, duration: textAppearDuration,
          easing: "cubic-bezier(.2, 0, 0, 1)", fill: "backwards",
        }));
      }
    }
    const stopForReducedMotion = () => {
      if (motion.matches || document.documentElement.dataset.uiMotion === "reduce") stop();
    };
    const observer = new MutationObserver(stopForReducedMotion);
    const stop = () => {
      for (const animation of animations) {
        if (animation.playState !== "finished" && animation.playState !== "idle") animation.cancel();
      }
      for (const group of axisGroups) group.removeAttribute("clip-path");
      for (const axisClip of axisClips) axisClip.remove();
      if (stems) stems.style.visibility = previousStemVisibility;
      animatedStems?.remove();
      motion.removeEventListener("change", stopForReducedMotion);
      observer.disconnect();
      if (stopGrowth.current === stop) stopGrowth.current = null;
    };
    stopGrowth.current = stop;
    motion.addEventListener("change", stopForReducedMotion);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-ui-motion"]});
    const last = animations.reduce((latest, animation) => {
      const timing = animation.effect?.getTiming();
      const latestTiming = latest.effect?.getTiming();
      return Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0)
        > Number(latestTiming?.delay ?? 0) + Number(latestTiming?.duration ?? 0) ? animation : latest;
    });
    last.onfinish = stop;
    return stop;
  }, [openToken, active, axisReady, axisVisible, eventsReady, geometry.width, geometry.height, axisScreenY, eventSnapshot.events, growthClipId]);

  function finishGrowth() {
    handledOpen.current = openToken;
    stopGrowth.current?.();
  }
  // Keep the SVG's intrinsic size and fonts in screen pixels. This cancels the
  // surface's world transform before SVG painting, instead of magnifying tiny text.
  const axisOverlayStyle = {
    width: size.width,
    height: size.height,
    transform: `translate(${view.center.x - worldHalfWidth}px, ${view.center.y - geometry.worldHeight / 2}px) scale(${1 / view.zoom})`,
  };
  const unitTop = axisVisible ? Math.max(8, Math.min(size.height - 44, axisScreenY - 52)) : 8;
  const draftDirty = draftIsDirty(draft, snapshot.settings);
  const parsedOrigin = Number(draft?.origin ?? "");
  const parsedStep = Number(draft?.step ?? "");
  const trimmedUnit = draft?.unit.trim() ?? "";
  const inputValid = Boolean(draft?.origin.trim() && draft.step.trim() && trimmedUnit)
    && Number.isFinite(parsedOrigin) && Math.abs(parsedOrigin) <= 1_000_000_000
    && Number.isFinite(parsedStep) && parsedStep >= 0.000001 && parsedStep <= 1_000_000_000
    && [...trimmedUnit].length <= 20 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmedUnit);
  const Surface = canvas.Surface;
  const surfaceActive = active && !editing && !eventEditing && !relationFocused;

  return <div className="timeline-canvas-frame" ref={frame} onPointerDownCapture={finishGrowth} onWheelCapture={finishGrowth}
    onKeyDownCapture={finishGrowth} onFocusCapture={finishGrowth}>
    <Surface viewport={viewport} active={surfaceActive} label={`${title}时间轴`} grid="none" showControls={!relationFocused}
      zoomControls={<TimelineTextZoomSwitch checked={scaleTextWithZoom} disabled={!surfaceActive || view.disposed}
        onChange={canvasView.setScaleTextWithZoom} />}>
      {snapshot.loaded && geometry.width > 0 && geometry.height > 0 && <div className="timeline-axis-overlay" style={axisOverlayStyle}>
        <svg className="timeline-axis-svg" role="img"
          aria-label={`${title}，单位${snapshot.settings.unit}，故事起点为${formatTimelineAxisValue(snapshot.settings.origin)}`}
          width={geometry.width} height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
          <title>{`${title}时间轴：原点 ${formatTimelineAxisValue(snapshot.settings.origin)} ${snapshot.settings.unit}`}</title>
          <defs />
          {axisVisible && <g className="timeline-axis">
            <line ref={axisLine} className="timeline-axis-line" x1="0" x2={geometry.width - 12} y1={axisScreenY} y2={axisScreenY}/>
            <AxisTicks ticks={geometry.ticks} axisY={axisScreenY} worldHalfWidth={worldHalfWidth} zoom={view.zoom}/>
            <path className="timeline-axis-arrow" d={`M ${geometry.width - 12} ${axisScreenY - 4} L ${geometry.width - 2} ${axisScreenY} L ${geometry.width - 12} ${axisScreenY + 4} Z`}/>
          </g>}
        </svg>
      </div>}
      {snapshot.loaded && <TimelineEvents contextMenus={contextMenus} assetCatalog={assetCatalog} assetRelations={assetRelations}
        store={events} settings={snapshot.settings} view={view} size={size}
        openToken={openToken}
        growthGeometryRef={growthGeometry}
        growthStemsRef={growthStems}
        axisLabelBounds={geometry.labelBounds}
        scaleTextWithZoom={scaleTextWithZoom}
        active={active && snapshot.loaded && !snapshot.loading && !snapshot.blocked && !editing}
        onEditingChange={setIsEventEditing} onRelationFocusChange={setRelationFocused}/>}
    </Surface>

    <div className="timeline-axis-unit" style={{top: unitTop}}>
      <Button variant="ghost" disabled={!active || eventEditing || !snapshot.loaded || snapshot.blocked || snapshot.loading} onClick={beginEditing}>
        单位：{snapshot.loaded ? snapshot.settings.unit : "—"}
      </Button>
    </div>

    {!snapshot.loading && snapshot.error && <div className="timeline-axis-feedback" role="alert">
      <span>{snapshot.error}</span>
      <Button variant="ghost" disabled={!active || snapshot.loading || snapshot.saving || submitting} onClick={() => void retrySettings()}>重试</Button>
    </div>}
    {snapshot.loading && <div className="timeline-axis-feedback" role="status">正在读取时间轴设置…</div>}

    <Dialog open={editing && active} onOpenChange={open => {
      if (!open && (!draftDirty || snapshot.error) && !snapshot.saving && !submitting) discardDraft();
    }} title="时间轴设置" size="narrow" description="设置故事起点和刻度，左侧递减，右侧递增。"
      busy={snapshot.saving || submitting} initialFocus={originInput}>
      <form className="timeline-axis-form" onSubmit={submitSettings}>
        <label className="timeline-axis-field"><span>故事起点数值</span>
          <TextField ref={originInput} name="origin" type="number" min="-1000000000" max="1000000000" step="any" required value={draft?.origin ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, origin: event.target.value} : current); }}
            aria-describedby="timeline-axis-origin-help"
            aria-invalid={Boolean(draft?.origin.trim()) && (!Number.isFinite(parsedOrigin) || Math.abs(parsedOrigin) > 1_000_000_000) || undefined}
            disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-origin-help" className="timeline-axis-field-help">故事开始时的数值，例如 100。</span>
        </label>
        <label className="timeline-axis-field"><span>主刻度间隔</span>
          <TextField name="step" type="number" min="0.000001" max="1000000000" step="any" required value={draft?.step ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, step: event.target.value} : current); }}
            aria-describedby="timeline-axis-step-help"
            aria-invalid={Boolean(draft?.step.trim()) && (!Number.isFinite(parsedStep) || parsedStep < 0.000001 || parsedStep > 1_000_000_000) || undefined}
            disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-step-help" className="timeline-axis-field-help">相邻主刻度的数值增量。</span>
        </label>
        <label className="timeline-axis-field"><span>单位</span>
          <TextField name="unit" type="text" required value={draft?.unit ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, unit: event.target.value} : current); }}
            aria-describedby="timeline-axis-unit-help" disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-unit-help" className="timeline-axis-field-help">1–20 个字符，例如天、年或轮次。</span>
        </label>
        {(operationError || snapshot.error) && <p className="timeline-axis-form-error" role="alert">{operationError ?? snapshot.error}</p>}
        <DialogActions>
          <Button variant="secondary" type="button" disabled={snapshot.saving || submitting} onClick={discardDraft}>取消</Button>
          <Button type="submit" variant="primary" disabled={snapshot.saving || submitting || !inputValid || (!draftDirty && !snapshot.error)}>
            {snapshot.saving || submitting ? "正在保存…" : snapshot.error && (!draftDirty || snapshot.saveState === "error") ? "重试保存" : "保存设置"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  </div>;
}

export default TimelineCanvas;
