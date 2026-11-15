import {useLayoutEffect, useMemo, useState, type RefObject} from "react";
import type {OrbitViewport} from "./timelineAssetOrbit";

export function useTimelineRelationViewport(scrollport: RefObject<HTMLDivElement | null>, {
  assetId, width, height, diameter, overflow, compact,
}: {assetId?: string; width: number; height: number; diameter: number; overflow: boolean; compact: boolean}) {
  const layout = useMemo(() => ({
    assetId, diameter, overflow, compact,
    initial: {left: (diameter - width) / 2, top: (diameter - height) / 2, width, height},
  }), [assetId, diameter, width, height, overflow, compact]);
  const [scroll, setScroll] = useState<{
    layout: typeof layout; viewport: OrbitViewport; focusedPeerId: string | undefined;
  } | null>(null);

  useLayoutEffect(() => {
    const element = scrollport.current;
    if (!element) return;
    const {clientWidth: width, clientHeight: height, scrollWidth, scrollHeight} = element;
    element.scrollLeft = Math.max(0, (scrollWidth - width) / 2);
    element.scrollTop = Math.max(0, (scrollHeight - height) / 2);
    if (!layout.assetId || !layout.overflow || layout.compact) return;

    const offsetX = (layout.diameter - scrollWidth) / 2;
    const offsetY = (layout.diameter - scrollHeight) / 2;
    let previousLeft = element.scrollLeft;
    let previousTop = element.scrollTop;
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const {scrollLeft, scrollTop} = element;
        if (scrollLeft === previousLeft && scrollTop === previousTop) return;
        previousLeft = scrollLeft;
        previousTop = scrollTop;
        // Scrolling away must not unmount a keyboard-focused label or node.
        const target = document.activeElement;
        const focusedPeerId = element.contains(target) ? target?.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined;
        setScroll({layout, viewport: {left: scrollLeft + offsetX, top: scrollTop + offsetY, width, height}, focusedPeerId});
      });
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      const focusedPeerId = next instanceof Element && element.contains(next)
        ? next.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined;
      setScroll(current => current?.layout === layout && current.focusedPeerId !== focusedPeerId
        ? {...current, focusedPeerId} : current);
    };
    element.addEventListener("scroll", onScroll, {passive: true});
    element.addEventListener("focusout", onFocusOut);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("focusout", onFocusOut);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [layout, scrollport]);

  return {initial: layout.initial, scrolled: scroll?.layout === layout ? scroll : null};
}
