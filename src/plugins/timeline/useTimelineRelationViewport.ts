import {useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import type {CanvasPoint} from "@lodestory/sdk/canvas";
import type {OrbitViewport} from "./timelineAssetOrbit";

const stageMinScale = 2;
export const relationStageMinSize = `${stageMinScale * 100}%`;

type RelationLayout = Readonly<{assetId?: string; width: number; height: number; diameter: number; compact: boolean}>;
type ScrolledView = Readonly<{viewport: OrbitViewport; focusedPeerId: string | undefined}>;
type ZoomView = Readonly<{
  zoom: number;
  target?: ScrolledView & {geometry: RelationLayout; center: CanvasPoint};
}>;

const initialZoom: ZoomView = {zoom: 1};

function viewportStart(diagramSize: number, viewSize: number, scrollOffsetFromCenter: number) {
  // The centered scene is clipped by its stage, so only the stage sets the scroll limits.
  const scrollLimit = (Math.max(diagramSize, stageMinScale * viewSize) - viewSize) / 2;
  return (diagramSize - viewSize) / 2 + Math.max(-scrollLimit, Math.min(scrollLimit, scrollOffsetFromCenter));
}

function focusedPeer(element: HTMLDivElement, target: EventTarget | null) {
  return target instanceof Element && element.contains(target)
    ? target.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined;
}

export function useTimelineRelationViewport(scrollport: RefObject<HTMLDivElement | null>, {
  assetId, width, height, diameter, compact, closing,
}: RelationLayout & {closing: boolean}) {
  const geometry = useMemo(() => ({assetId, width, height, diameter, compact}), [assetId, width, height, diameter, compact]);
  const [zoomView, setZoomView] = useState(initialZoom);
  const pendingZoom = useRef<ZoomView | null>(null);
  const zoom = zoomView.zoom;
  const diagramSize = diameter * (assetId && !compact ? zoom : 1);
  const overflow = !compact && (diagramSize > width || diagramSize > height);
  const target = zoomView.target?.geometry === geometry ? zoomView.target : null;
  const layout = useMemo(() => ({
    diagramSize, zoomView, geometry, target,
    initial: {left: (diagramSize - width) / 2, top: (diagramSize - height) / 2, width, height},
  }), [diagramSize, zoomView, geometry, target, width, height]);
  const [scroll, setScroll] = useState<(ScrolledView & {layout: typeof layout}) | null>(null);

  const queueZoom = useCallback((element: HTMLDivElement, nextZoom: number, center: CanvasPoint,
    viewWidth: number, viewHeight: number) => {
    const nextSize = geometry.diameter * nextZoom;
    const nextView: ZoomView = {zoom: nextZoom, target: {
      geometry, center, focusedPeerId: focusedPeer(element, document.activeElement),
      viewport: {
        left: viewportStart(nextSize, viewWidth, center.x * nextZoom),
        top: viewportStart(nextSize, viewHeight, center.y * nextZoom),
        width: viewWidth, height: viewHeight,
      },
    }};
    pendingZoom.current = nextView;
    setZoomView(nextView);
  }, [geometry]);

  const zoomTo = useCallback((requested: number, point?: CanvasPoint) => {
    const element = scrollport.current;
    if (!element || !assetId || compact || closing || !Number.isFinite(requested)) return;
    const prior = pendingZoom.current?.target?.geometry === geometry ? pendingZoom.current : null;
    const currentZoom = prior?.zoom ?? zoom;
    const nextZoom = Math.min(4, Math.max(0.25, requested));
    if (nextZoom === currentZoom) return;
    const {clientWidth, clientHeight, scrollWidth, scrollHeight, scrollLeft, scrollTop} = element;
    const dx = point ? point.x - clientWidth / 2 : 0;
    const dy = point ? point.y - clientHeight / 2 : 0;
    const center = prior?.target?.center ?? {
      x: (scrollLeft + (clientWidth - scrollWidth) / 2) / currentZoom,
      y: (scrollTop + (clientHeight - scrollHeight) / 2) / currentZoom,
    };
    queueZoom(element, nextZoom, {
      x: center.x + dx / currentZoom - dx / nextZoom,
      y: center.y + dy / currentZoom - dy / nextZoom,
    }, clientWidth, clientHeight);
  }, [assetId, compact, closing, scrollport, geometry, zoom, queueZoom]);

  const resetView = useCallback(() => {
    const element = scrollport.current;
    if (!element || !assetId || compact || closing) return;
    queueZoom(element, 1, {x: 0, y: 0}, element.clientWidth, element.clientHeight);
  }, [scrollport, assetId, compact, closing, queueZoom]);

  useLayoutEffect(() => {
    if (!assetId && zoom !== 1) {
      pendingZoom.current = null;
      setZoomView(initialZoom);
    }
  }, [assetId, zoom]);

  useLayoutEffect(() => {
    const element = scrollport.current;
    if (!element) return;
    if (pendingZoom.current === layout.zoomView) pendingZoom.current = null;
    const {clientWidth: width, clientHeight: height, scrollWidth, scrollHeight} = element;
    const center = layout.target?.center;
    element.scrollLeft = (scrollWidth - width) / 2 + (center ? center.x * layout.zoomView.zoom : 0);
    element.scrollTop = (scrollHeight - height) / 2 + (center ? center.y * layout.zoomView.zoom : 0);
    if (!layout.geometry.assetId || layout.geometry.compact) return;

    const offsetX = (layout.diagramSize - scrollWidth) / 2;
    const offsetY = (layout.diagramSize - scrollHeight) / 2;
    let previousLeft = element.scrollLeft;
    let previousTop = element.scrollTop;
    let frame: number | null = null;
    const updateVisible = (scrollLeft: number, scrollTop: number) => {
      // Keep a keyboard-focused node or label mounted even when its position leaves the view.
      setScroll({layout, viewport: {left: scrollLeft + offsetX, top: scrollTop + offsetY, width, height},
        focusedPeerId: focusedPeer(element, document.activeElement)});
    };
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const {scrollLeft, scrollTop} = element;
        if (scrollLeft === previousLeft && scrollTop === previousTop) return;
        previousLeft = scrollLeft;
        previousTop = scrollTop;
        updateVisible(scrollLeft, scrollTop);
      });
    };
    const updateFocusedPeer = (elementTarget: EventTarget | null) => {
      const focusedPeerId = focusedPeer(element, elementTarget);
      setScroll(current => {
        const view = current?.layout === layout ? current : layout.target;
        return view && view.focusedPeerId !== focusedPeerId ? {layout, viewport: view.viewport, focusedPeerId} : current;
      });
    };
    const onFocusIn = (event: FocusEvent) => updateFocusedPeer(event.target);
    const onFocusOut = (event: FocusEvent) => updateFocusedPeer(event.relatedTarget);
    element.addEventListener("scroll", onScroll, {passive: true});
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", onFocusOut);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [layout, scrollport]);

  useLayoutEffect(() => {
    const element = scrollport.current;
    if (!element || !assetId || compact || closing) return;
    let drag: {pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number} | null = null;

    const stopDrag = () => {
      if (!drag) return;
      const {pointerId} = drag;
      drag = null;
      delete element.dataset.dragging;
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (drag || event.ctrlKey || (event.button !== 0 && event.button !== 1)) return;
      if (!(event.target instanceof Element) || event.target.closest("button, a")) return;
      const {left, top} = element.getBoundingClientRect();
      if (event.clientX >= left + element.clientWidth || event.clientY >= top + element.clientHeight) return;
      try { element.setPointerCapture(event.pointerId); }
      catch { return; }
      event.preventDefault();
      element.focus({preventScroll: true});
      drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        scrollLeft: element.scrollLeft, scrollTop: element.scrollTop};
      element.dataset.dragging = "";
    };
    const moveDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      element.scrollLeft = drag.scrollLeft + drag.x - event.clientX;
      element.scrollTop = drag.scrollTop + drag.y - event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== drag?.pointerId) return;
      moveDrag(event);
      stopDrag();
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerId === drag?.pointerId) stopDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== element || event.key !== "Home" || event.isComposing) return;
      event.preventDefault();
      stopDrag();
      resetView();
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      stopDrag();
      const {left, top} = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const pending = pendingZoom.current?.target?.geometry === geometry ? pendingZoom.current : null;
      zoomTo((pending?.zoom ?? zoom) * Math.exp(-event.deltaY * unit * 0.002),
        {x: event.clientX - left, y: event.clientY - top});
    };
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", moveDrag);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerEnd);
    element.addEventListener("lostpointercapture", onPointerEnd);
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("wheel", onWheel, {passive: false});
    window.addEventListener("blur", stopDrag);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", moveDrag);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerEnd);
      element.removeEventListener("lostpointercapture", onPointerEnd);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", stopDrag);
      stopDrag();
    };
  }, [assetId, compact, geometry, zoom, scrollport, closing, resetView, zoomTo]);

  return {diagramSize, overflow, zoom, zoomTo, resetView, initial: layout.initial, scrolled: scroll?.layout === layout ? scroll : target};
}
