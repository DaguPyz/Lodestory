import {useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import type {CanvasPoint} from "@lodestory/sdk/canvas";
import type {OrbitViewport} from "./timelineAssetOrbit";

type ZoomTarget = {assetId: string; zoom: number; center: CanvasPoint};

function centerScrollport(element: HTMLDivElement, target?: ZoomTarget) {
  element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 + (target ? target.center.x * target.zoom : 0);
  element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 + (target ? target.center.y * target.zoom : 0);
}

export function useTimelineRelationViewport(scrollport: RefObject<HTMLDivElement | null>, {
  assetId, width, height, diameter, compact, closing,
}: {assetId?: string; width: number; height: number; diameter: number; compact: boolean; closing: boolean}) {
  const [zoom, setZoom] = useState(1);
  const pendingZoom = useRef<ZoomTarget | null>(null);
  const diagramSize = diameter * (assetId && !compact ? zoom : 1);
  const overflow = !compact && (diagramSize > width || diagramSize > height);
  const layout = useMemo(() => ({
    assetId, diagramSize, compact, zoom,
    initial: {left: (diagramSize - width) / 2, top: (diagramSize - height) / 2, width, height},
  }), [assetId, diagramSize, width, height, compact, zoom]);
  const previousLayout = useRef<typeof layout | null>(null);
  const [scroll, setScroll] = useState<{
    layout: typeof layout; viewport: OrbitViewport; focusedPeerId: string | undefined;
  } | null>(null);

  const zoomTo = useCallback((requested: number, point?: CanvasPoint) => {
    const element = scrollport.current;
    if (!element || !assetId || compact || closing || !Number.isFinite(requested)) return;
    const prior = pendingZoom.current?.assetId === assetId ? pendingZoom.current : null;
    const currentZoom = prior?.zoom ?? zoom;
    const nextZoom = Math.min(4, Math.max(0.25, requested));
    if (nextZoom === currentZoom) return;
    const {clientWidth, clientHeight, scrollWidth, scrollHeight, scrollLeft, scrollTop} = element;
    const dx = point ? point.x - clientWidth / 2 : 0;
    const dy = point ? point.y - clientHeight / 2 : 0;
    const center = prior?.center ?? {
      x: (scrollLeft + (clientWidth - scrollWidth) / 2) / currentZoom,
      y: (scrollTop + (clientHeight - scrollHeight) / 2) / currentZoom,
    };
    const target = {assetId, zoom: nextZoom, center: {
      x: center.x + dx / currentZoom - dx / nextZoom,
      y: center.y + dy / currentZoom - dy / nextZoom,
    }};
    pendingZoom.current = nextZoom === zoom ? null : target;
    if (nextZoom === zoom) centerScrollport(element, target);
    setZoom(nextZoom);
  }, [assetId, compact, closing, scrollport, zoom]);

  const resetView = useCallback(() => {
    pendingZoom.current = null;
    if (zoom === 1 && scrollport.current) centerScrollport(scrollport.current);
    setZoom(1);
  }, [scrollport, zoom]);

  useLayoutEffect(() => {
    if (!assetId && zoom !== 1) resetView();
  }, [assetId, resetView, zoom]);

  useLayoutEffect(() => {
    const element = scrollport.current;
    if (!element) return;
    const previous = previousLayout.current;
    previousLayout.current = layout;
    const anchor = pendingZoom.current;
    pendingZoom.current = null;
    centerScrollport(element, anchor?.assetId === layout.assetId && anchor?.zoom === layout.zoom ? anchor : undefined);
    if (!layout.assetId || layout.compact) return;

    const {clientWidth: width, clientHeight: height, scrollWidth, scrollHeight} = element;
    const offsetX = (layout.diagramSize - scrollWidth) / 2;
    const offsetY = (layout.diagramSize - scrollHeight) / 2;
    let previousLeft = element.scrollLeft;
    let previousTop = element.scrollTop;
    let frame: number | null = null;
    const updateVisible = (scrollLeft: number, scrollTop: number) => {
      // Keep a keyboard-focused node or label mounted even when its position leaves the view.
      const target = document.activeElement;
      const focusedPeerId = element.contains(target) ? target?.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined;
      setScroll({layout, viewport: {left: scrollLeft + offsetX, top: scrollTop + offsetY, width, height}, focusedPeerId});
    };
    if (previous?.assetId === layout.assetId && previous.zoom !== layout.zoom) updateVisible(previousLeft, previousTop);
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
    const updateFocusedPeer = (target: EventTarget | null) => {
      const focusedPeerId = target instanceof Element && element.contains(target)
        ? target.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined;
      setScroll(current => current?.layout === layout && current.focusedPeerId !== focusedPeerId
        ? {...current, focusedPeerId} : current);
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
    if (!element || !layout.assetId || layout.compact || closing) return;
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
      zoomTo((pendingZoom.current?.zoom ?? layout.zoom) * Math.exp(-event.deltaY * unit * 0.002),
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
  }, [layout, scrollport, closing, resetView, zoomTo]);

  return {diagramSize, overflow, zoom, zoomTo, resetView, initial: layout.initial, scrolled: scroll?.layout === layout ? scroll : null};
}
