import {useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import type {CanvasService, CanvasViewport} from "@lodestory/sdk/canvas";
import {Button, Dialog, DialogActions} from "@lodestory/ui";
import type {TimelineAxisStore, TimelineAxisSettings} from "./timelineAxisStore";
import {formatTimelineAxisValue, getTimelineAxisGeometry, type TimelineAxisTick} from "./timelineAxisGeometry";

type Draft = {origin: string; step: string; unit: string};
type Size = {width: number; height: number};

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

function AxisTicks({ticks, axisY, zoom}: {ticks: readonly TimelineAxisTick[]; axisY: number; zoom: number}) {
  const inverseZoom = 1 / zoom;
  return <g className="timeline-axis-ticks">
    {ticks.map(tick => <g key={tick.key}>
      <line className={tick.origin ? "timeline-axis-tick timeline-axis-tick-origin" : "timeline-axis-tick"}
        x1={tick.x} x2={tick.x} y1={axisY} y2={axisY + (tick.origin ? 16 : tick.major ? 14 : 8) * inverseZoom}
        vectorEffect="non-scaling-stroke"/>
      {tick.labelVisible && <>
        <text className={tick.origin ? "timeline-axis-label timeline-axis-label-origin" : "timeline-axis-label"}
          x={tick.x} y={axisY + 21 * inverseZoom} fontSize={14 * inverseZoom} textAnchor="middle" dominantBaseline="hanging">
          {formatTimelineAxisValue(tick.value)}
        </text>
        {tick.origin && <text className="timeline-axis-origin-caption" x={tick.x} y={axisY + 41 * inverseZoom}
          fontSize={11 * inverseZoom} textAnchor="middle" dominantBaseline="hanging">故事起点</text>}
      </>}
    </g>)}
  </g>;
}

export function TimelineCanvas({canvas, viewport, active, title, axis, onEditingChange}: {
  canvas: CanvasService;
  viewport: CanvasViewport;
  active: boolean;
  title: string;
  axis: TimelineAxisStore;
  onEditingChange?: (editing: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(axis.subscribe, axis.getSnapshot, axis.getSnapshot);
  const view = useSyncExternalStore(viewport.subscribe, viewport.getSnapshot, viewport.getSnapshot);
  const frame = useRef<HTMLDivElement>(null);
  const originInput = useRef<HTMLInputElement>(null);
  const onEditingChangeRef = useRef(onEditingChange);
  const editingOwnerRef = useRef<((editing: boolean) => void) | null>(null);
  const editingRef = useRef(false);
  const resourcesRef = useRef({viewport, axis});
  const operationEpochRef = useRef(0);
  const [size, setSize] = useState<Size>({width: 0, height: 0});
  const [editing, setEditing] = useState(false);
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

  useLayoutEffect(() => {
    const resourcesChanged = resourcesRef.current.viewport !== viewport || resourcesRef.current.axis !== axis;
    resourcesRef.current = {viewport, axis};
    if (resourcesChanged) {
      operationEpochRef.current++;
      setSubmitting(false);
      setOperationError(null);
      if (editingRef.current || draft) discardDraft();
    }
  }, [viewport, axis, draft]);

  function beginEditing() {
    if (!active || !snapshot.loaded || snapshot.blocked || snapshot.loading) return;
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
  const worldHalfHeight = geometry.worldHeight / 2;
  const axisVisible = geometry.axisY >= -worldHalfHeight && geometry.axisY <= worldHalfHeight;
  const axisScreenY = size.height / 2 + geometry.axisY * view.zoom;
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

  return <div className="timeline-canvas-frame" ref={frame}>
    <Surface viewport={viewport} active={active} label={`${title}时间轴`} grid="none">
      {snapshot.loaded && geometry.width > 0 && geometry.height > 0 && <svg className="timeline-axis-svg" role="img"
        aria-label={`${title}，单位${snapshot.settings.unit}，故事起点为${formatTimelineAxisValue(snapshot.settings.origin)}`}
        width={geometry.worldWidth} height={geometry.worldHeight}
        viewBox={`${-worldHalfWidth} ${-worldHalfHeight} ${geometry.worldWidth} ${geometry.worldHeight}`}
        style={{left: geometry.centerX, top: geometry.centerY, transform: "translate(-50%, -50%)"}}>
        <title>{`${title}时间轴：原点 ${formatTimelineAxisValue(snapshot.settings.origin)} ${snapshot.settings.unit}`}</title>
        {axisVisible && <g className="timeline-axis">
          <line className="timeline-axis-line" x1={-worldHalfWidth} x2={geometry.arrowBaseX} y1={geometry.axisY} y2={geometry.axisY}
            vectorEffect="non-scaling-stroke"/>
          <AxisTicks ticks={geometry.ticks} axisY={geometry.axisY} zoom={view.zoom}/>
          <path className="timeline-axis-arrow" d={`M ${geometry.arrowBaseX} ${geometry.axisY - 4 / view.zoom} L ${geometry.arrowTipX} ${geometry.axisY} L ${geometry.arrowBaseX} ${geometry.axisY + 4 / view.zoom} Z`}/>
        </g>}
      </svg>}
    </Surface>

    <div className="timeline-axis-unit" style={{top: unitTop}}>
      <Button variant="ghost" disabled={!active || !snapshot.loaded || snapshot.blocked || snapshot.loading} onClick={beginEditing}>
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
          <input ref={originInput} name="origin" type="number" min="-1000000000" max="1000000000" step="any" required value={draft?.origin ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, origin: event.target.value} : current); }}
            aria-describedby="timeline-axis-origin-help"
            aria-invalid={Boolean(draft?.origin.trim()) && (!Number.isFinite(parsedOrigin) || Math.abs(parsedOrigin) > 1_000_000_000) || undefined}
            disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-origin-help" className="timeline-axis-field-help">故事开始时的数值，例如 100。</span>
        </label>
        <label className="timeline-axis-field"><span>主刻度间隔</span>
          <input name="step" type="number" min="0.000001" max="1000000000" step="any" required value={draft?.step ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, step: event.target.value} : current); }}
            aria-describedby="timeline-axis-step-help"
            aria-invalid={Boolean(draft?.step.trim()) && (!Number.isFinite(parsedStep) || parsedStep < 0.000001 || parsedStep > 1_000_000_000) || undefined}
            disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-step-help" className="timeline-axis-field-help">相邻主刻度的数值增量。</span>
        </label>
        <label className="timeline-axis-field"><span>单位</span>
          <input name="unit" type="text" required value={draft?.unit ?? ""}
            onChange={event => { setOperationError(null); setDraft(current => current ? {...current, unit: event.target.value} : current); }}
            aria-describedby="timeline-axis-unit-help" disabled={submitting || snapshot.saving}/>
          <span id="timeline-axis-unit-help" className="timeline-axis-field-help">1–20 个字符，例如天、年或轮次。</span>
        </label>
        {(operationError || snapshot.error) && <p className="timeline-axis-form-error" role="alert">{operationError ?? snapshot.error}</p>}
        <DialogActions>
          <Button type="button" disabled={snapshot.saving || submitting} onClick={discardDraft}>取消</Button>
          <Button type="submit" variant="primary" disabled={snapshot.saving || submitting || !inputValid || (!draftDirty && !snapshot.error)}>
            {snapshot.saving || submitting ? "正在保存…" : snapshot.error && (!draftDirty || snapshot.saveState === "error") ? "重试保存" : "保存设置"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  </div>;
}

export default TimelineCanvas;
