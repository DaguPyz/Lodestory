import {useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent} from "react";
import type {CanvasSize, CanvasSurfaceProps} from "@lodestory/sdk/canvas";
import {Button, Icon, IconButton} from "@lodestory/ui";
import "./canvas.css";

type Drag = {pointerId: number; x: number; y: number};
const interactiveSelector = "input,textarea,select,button,a,[contenteditable]:not([contenteditable='false']),[data-canvas-interactive]";
const isInteractive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(interactiveSelector));
const isTextInput = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])"));

/** All DOM listeners and pointer capture belong to this mounted surface, not the viewport model. */
export function CanvasSurface({viewport, active, label, children}: CanvasSurfaceProps) {
  const snapshot = useSyncExternalStore(viewport.subscribe, viewport.getSnapshot, viewport.getSnapshot);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const spaceDown = useRef(false);
  const [hand, setHand] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<CanvasSize>({width: 0, height: 0});
  const patternId = `canvas-grid-${useId().replace(/:/g, "")}`;
  const enabled = active && !snapshot.disposed;

  function finishDrag(updateUi = true) {
    const current = drag.current;
    drag.current = null;
    const element = surface.current;
    if (current && element?.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
    if (updateUi) setDragging(false);
  }
  function finishGesture(updateUi = true) {
    finishDrag(updateUi);
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
    function wheel(event: WheelEvent) {
      if (isInteractive(event.target)) return;
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      if (event.ctrlKey || event.metaKey) {
        const current = viewport.getSnapshot();
        viewport.zoomTo(current.zoom * Math.exp(-event.deltaY * unit * 0.002), {
          point: {x: event.clientX - rect.left, y: event.clientY - rect.top},
          size: {width: rect.width, height: rect.height},
        });
      } else viewport.panBy(-event.deltaX * unit, -event.deltaY * unit);
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
      finishGesture(false);
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
    viewport.panBy(x, y);
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) finishGesture();
  }

  const offset = {x: size.width / 2 - snapshot.center.x * snapshot.zoom, y: size.height / 2 - snapshot.center.y * snapshot.zoom};
  // Keep the dot pitch between 24 and 48 CSS pixels while anchoring it in world coordinates.
  const gridStep = 32 * 2 ** Math.ceil(Math.log2(24 / (32 * snapshot.zoom)));
  const pitch = gridStep * snapshot.zoom;
  const gridOffset = {x: ((offset.x % pitch) + pitch) % pitch, y: ((offset.y % pitch) + pitch) % pitch};
  const percentage = `${Math.round(snapshot.zoom * 100)}%`;

  return <div ref={surface} className="canvas-surface" role="region" aria-label={label} tabIndex={0}
    aria-description="方向键平移，空格加左键或中键拖动，Ctrl 或 Command 加滚轮缩放，Home 回到原点。"
    data-canvas-active={enabled} data-canvas-hand={hand} data-canvas-dragging={dragging}
    data-canvas-center-x={snapshot.center.x} data-canvas-center-y={snapshot.center.y} data-canvas-zoom={snapshot.zoom}
    onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(); }} onPointerCancel={pointerEnd}
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
      if (movement) { event.preventDefault(); viewport.panBy(...movement); }
      if (event.key === "Home") { event.preventDefault(); viewport.resetView(); }
    }}>
    <svg className="canvas-grid" aria-hidden="true" width="100%" height="100%">
      <defs><pattern id={patternId} width={pitch} height={pitch} x={gridOffset.x} y={gridOffset.y} patternUnits="userSpaceOnUse">
        <circle cx={pitch / 2} cy={pitch / 2} r="1" fill="currentColor"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`}/>
    </svg>
    <div className="canvas-world" style={{transform: `translate(${offset.x}px, ${offset.y}px) scale(${snapshot.zoom})`}}>
      {children}
    </div>
    <div className="canvas-controls" role="toolbar" aria-label="画布视图">
      <IconButton label="缩小画布" disabled={!enabled || snapshot.zoom <= 0.25} onClick={() => viewport.zoomTo(snapshot.zoom / 1.25)}>
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>
      </IconButton>
      <span className="canvas-zoom-value"><Button variant="ghost" title="恢复到 100%" aria-label={`画布缩放 ${percentage}，恢复到 100%`}
        disabled={!enabled} onClick={() => viewport.resetZoom()}>{percentage}</Button></span>
      <IconButton label="放大画布" disabled={!enabled || snapshot.zoom >= 4} onClick={() => viewport.zoomTo(snapshot.zoom * 1.25)}><Icon name="plus"/></IconButton>
      <Button variant="ghost" disabled={!enabled} onClick={() => viewport.resetView()}><Icon name="focus"/>回到原点</Button>
    </div>
  </div>;
}
