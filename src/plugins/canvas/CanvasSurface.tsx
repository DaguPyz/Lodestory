import {useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent} from "react";
import type {CanvasSize, CanvasSurfaceProps, CanvasViewport} from "@lodestory/sdk/canvas";
import {CanvasZoomControls} from "@lodestory/ui";
import "./canvas.css";

type Drag = {pointerId: number; x: number; y: number};
type PanAccumulator = {
  viewport: CanvasViewport;
  enqueue(x: number, y: number): void;
  flush(): void;
  discard(): void;
};
const interactiveSelector = "input,textarea,select,button,a,[contenteditable]:not([contenteditable='false']),[data-canvas-interactive]";
const isInteractive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(interactiveSelector));
const isTextInput = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])"));

/** Coalesce input deltas without changing the viewport's synchronous public panBy contract. */
function createPanAccumulator(viewport: CanvasViewport, host: Window): PanAccumulator {
  const requestFrame = typeof host.requestAnimationFrame === "function" ? host.requestAnimationFrame.bind(host) : null;
  const cancelFrame = typeof host.cancelAnimationFrame === "function" ? host.cancelAnimationFrame.bind(host) : null;
  let x = 0;
  let y = 0;
  let frame: number | null = null;
  let revision = 0;
  let closed = false;

  function cancelScheduledFrame() {
    if (frame === null) return;
    const current = frame;
    frame = null;
    revision++;
    cancelFrame?.(current);
  }

  function applyPending() {
    const dx = x;
    const dy = y;
    x = 0;
    y = 0;
    if (dx !== 0 || dy !== 0) viewport.panBy(dx, dy);
  }

  return {
    viewport,
    enqueue(dx, dy) {
      if (closed) return;
      if (!requestFrame) {
        viewport.panBy(dx, dy);
        return;
      }
      x += dx;
      y += dy;
      if (frame !== null) return;
      const currentRevision = ++revision;
      frame = requestFrame(() => {
        if (closed || currentRevision !== revision) return;
        frame = null;
        applyPending();
      });
    },
    flush() {
      if (closed) return;
      cancelScheduledFrame();
      applyPending();
    },
    discard() {
      if (closed) return;
      cancelScheduledFrame();
      x = 0;
      y = 0;
      closed = true;
    },
  };
}

/** All DOM listeners and pointer capture belong to this mounted surface, not the viewport model. */
export function CanvasSurface({viewport, active, label, children, grid = "dots", showControls = true, zoomControls}: CanvasSurfaceProps) {
  const snapshot = useSyncExternalStore(viewport.subscribe, viewport.getSnapshot, viewport.getSnapshot);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const panAccumulator = useRef<PanAccumulator | null>(null);
  const spaceDown = useRef(false);
  const [hand, setHand] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<CanvasSize>({width: 0, height: 0});
  const patternId = `canvas-grid-${useId().replace(/:/g, "")}`;
  const enabled = active && !snapshot.disposed;

  function flushPan(targetViewport?: CanvasViewport) {
    const accumulator = panAccumulator.current;
    if (accumulator && (!targetViewport || accumulator.viewport === targetViewport)) accumulator.flush();
  }
  function finishDrag(updateUi = true, flush = true) {
    if (flush) flushPan();
    const current = drag.current;
    drag.current = null;
    const element = surface.current;
    if (current && element?.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
    if (updateUi) setDragging(false);
  }
  function finishGesture(updateUi = true, flush = true) {
    finishDrag(updateUi, flush);
    spaceDown.current = false;
    if (updateUi) setHand(false);
  }

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize(current => current.width === rect.width && current.height === rect.height ? current : {width: rect.width, height: rect.height});
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

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || !enabled) { finishGesture(); return; }
    const pan = createPanAccumulator(viewport, window);
    panAccumulator.current = pan;
    function wheel(event: WheelEvent) {
      if (isInteractive(event.target)) return;
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      if (event.ctrlKey || event.metaKey) {
        pan.flush();
        const current = viewport.getSnapshot();
        viewport.zoomTo(current.zoom * Math.exp(-event.deltaY * unit * 0.002), {
          point: {x: event.clientX - rect.left, y: event.clientY - rect.top},
          size: {width: rect.width, height: rect.height},
        });
      } else pan.enqueue(-event.deltaX * unit, -event.deltaY * unit);
    }
    function resetGesture() { finishGesture(); }
    function visibilityChanged() { if (document.hidden) resetGesture(); }
    function keydown(event: KeyboardEvent) {
      // Remember the physical key before the first canvas click, without consuming keys in other UI.
      if (event.code === "Space" && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextInput(event.target)) {
        spaceDown.current = true;
      }
    }
    function keyup(event: KeyboardEvent) {
      if (event.code === "Space") {
        spaceDown.current = false;
        setHand(false);
        if (drag.current) finishGesture();
        else flushPan(viewport);
      }
    }
    element.addEventListener("wheel", wheel, {passive: false});
    window.addEventListener("blur", resetGesture);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", resetGesture);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (panAccumulator.current === pan) panAccumulator.current = null;
      pan.discard();
      finishGesture(false, false);
    };
  }, [enabled, viewport]);

  // A timeline can swap its viewport without unmounting this surface.
  useLayoutEffect(() => { finishGesture(); }, [viewport]);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!enabled || isInteractive(event.target)) return;
    if (event.button === 0) event.currentTarget.focus({preventScroll: true});
    if (drag.current || event.button !== 1 && !(event.button === 0 && spaceDown.current)) return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll: true});
    drag.current = {pointerId: event.pointerId, x: event.clientX, y: event.clientY};
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { drag.current = null; return; }
    setDragging(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!enabled || !current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    const x = event.clientX - current.x;
    const y = event.clientY - current.y;
    current.x = event.clientX;
    current.y = event.clientY;
    const pan = panAccumulator.current;
    if (pan?.viewport === viewport) pan.enqueue(x, y);
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) finishGesture();
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    const x = event.clientX - current.x;
    const y = event.clientY - current.y;
    current.x = event.clientX;
    current.y = event.clientY;
    const pan = panAccumulator.current;
    if (pan?.viewport === viewport && (x !== 0 || y !== 0)) pan.enqueue(x, y);
    finishDrag();
  }

  const offset = {x: size.width / 2 - snapshot.center.x * snapshot.zoom, y: size.height / 2 - snapshot.center.y * snapshot.zoom};
  // Keep the dot pitch between 24 and 48 CSS pixels while anchoring it in world coordinates.
  const gridStep = 32 * 2 ** Math.ceil(Math.log2(24 / (32 * snapshot.zoom)));
  const pitch = gridStep * snapshot.zoom;
  const gridOffset = {x: ((offset.x % pitch) + pitch) % pitch, y: ((offset.y % pitch) + pitch) % pitch};

  return <div ref={surface} className="canvas-surface" role="region" aria-label={label} tabIndex={0}
    aria-description="方向键平移，空格加左键或中键拖动，Ctrl 或 Command 加滚轮缩放，Home 回到原点。"
    data-canvas-active={enabled} data-canvas-hand={hand} data-canvas-dragging={dragging}
    data-canvas-center-x={snapshot.center.x} data-canvas-center-y={snapshot.center.y} data-canvas-zoom={snapshot.zoom}
    onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={pointerUp} onPointerCancel={pointerEnd}
    onLostPointerCapture={pointerEnd}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) finishGesture(); }}
    onKeyDown={event => {
      if (!enabled || event.nativeEvent.isComposing || isInteractive(event.target)) return;
      if (event.key === "Escape") { finishGesture(); return; }
      if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); spaceDown.current = true; setHand(true);
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const distance = event.shiftKey ? 240 : 48;
      const moves: Record<string, [number, number]> = {ArrowLeft: [distance, 0], ArrowRight: [-distance, 0], ArrowUp: [0, distance], ArrowDown: [0, -distance]};
      const movement = moves[event.key];
      if (movement) { event.preventDefault(); flushPan(viewport); viewport.panBy(...movement); }
      if (event.key === "Home") { event.preventDefault(); flushPan(viewport); viewport.resetView(); }
    }}>
    {grid === "dots" && <svg className="canvas-grid" aria-hidden="true" width="100%" height="100%">
      <defs><pattern id={patternId} width={pitch} height={pitch} x={gridOffset.x} y={gridOffset.y} patternUnits="userSpaceOnUse">
        <circle cx={pitch / 2} cy={pitch / 2} r="1" fill="currentColor"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`}/>
    </svg>}
    <div className="canvas-world" style={{transform: `translate(${offset.x}px, ${offset.y}px) scale(${snapshot.zoom})`}}>
      {children}
    </div>
    {showControls && <CanvasZoomControls zoom={snapshot.zoom} disabled={!enabled}
      onZoomChange={zoom => { flushPan(viewport); viewport.zoomTo(zoom); }}
      onResetZoom={() => { flushPan(viewport); viewport.resetZoom(); }}
      onResetView={() => { flushPan(viewport); viewport.resetView(); }}>
      {zoomControls}
    </CanvasZoomControls>}
  </div>;
}
