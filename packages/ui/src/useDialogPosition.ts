import {useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent} from "react";
import {createDialogDragController, type DialogPoint} from "./dialogDragController.js";
import {centerDialogPosition, constrainDialogPosition, type DialogViewport} from "./dialogGeometry.js";

/** Presentation state belongs to one open popup, independently of its owner's form state. */
export function useDialogPosition(open: boolean) {
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createDialogDragController> | null>(null);
  const placement = useRef<{moveBy(x: number, y: number): void; center(): void} | null>(null);

  useLayoutEffect(() => {
    const handle = header.current;
    const view = popup?.ownerDocument.defaultView;
    if (!open || !popup || !handle || !view) return;
    let position: DialogPoint;
    const viewport = (): DialogViewport => ({
      x: view.visualViewport?.offsetLeft ?? 0,
      y: view.visualViewport?.offsetTop ?? 0,
      width: view.visualViewport?.width ?? view.innerWidth,
      height: view.visualViewport?.height ?? view.innerHeight,
    });
    // CSS zoom and browser zoom can differ; DOM rectangles and pointer coordinates share one space.
    const scale = () => {
      const width = Number.parseFloat(view.getComputedStyle(popup).width);
      return width > 0 ? popup.getBoundingClientRect().width / width : 1;
    };
    const size = () => {
      const rect = popup.getBoundingClientRect();
      return {width: rect.width, height: rect.height};
    };
    const constrain = (point: DialogPoint) => constrainDialogPosition(point, size(), viewport());
    const place = (point: DialogPoint) => {
      position = point;
      const zoom = scale();
      popup.style.setProperty("--cmp-dialog-x", `${point.x / zoom}px`);
      popup.style.setProperty("--cmp-dialog-y", `${point.y / zoom}px`);
      popup.dataset.positioned = "true";
    };
    const fitViewport = () => {
      const available = viewport();
      const zoom = scale();
      popup.style.setProperty("--cmp-dialog-max-width", `${Math.max(1, available.width - 32) / zoom}px`);
      popup.style.setProperty("--cmp-dialog-max-height", `${Math.max(1, available.height - 32) / zoom}px`);
    };
    fitViewport();
    place(centerDialogPosition(size(), viewport()));
    handle.tabIndex = -1;
    // Base UI chooses initial focus first; the title then joins the normal Tab order.
    const focusFrame = view.requestAnimationFrame(() => { handle.tabIndex = 0; });
    const drag = createDialogDragController({
      target: handle,
      getPosition: () => position,
      constrain,
      setPosition: place,
      onDraggingChange: dragging => { popup.dataset.dragging = String(dragging); },
    });
    controller.current = drag;
    placement.current = {
      moveBy(x, y) { place(constrain({x: position.x + x, y: position.y + y})); },
      center() { drag.cancel(); fitViewport(); place(centerDialogPosition(size(), viewport())); },
    };
    const fit = () => { fitViewport(); place(constrain(position)); };
    const cancel = () => { drag.cancel(); };
    const observer = new ResizeObserver(fit);
    observer.observe(popup);
    view.addEventListener("resize", fit);
    view.addEventListener("blur", cancel);
    view.visualViewport?.addEventListener("resize", fit);
    view.visualViewport?.addEventListener("scroll", fit);
    return () => {
      view.cancelAnimationFrame(focusFrame);
      observer.disconnect();
      view.removeEventListener("resize", fit);
      view.removeEventListener("blur", cancel);
      view.visualViewport?.removeEventListener("resize", fit);
      view.visualViewport?.removeEventListener("scroll", fit);
      drag.dispose();
      popup.dataset.dragging = "false";
      handle.tabIndex = -1;
      controller.current = null;
      placement.current = null;
      // Keep the last coordinates during the closing fade; the next open centers afresh.
    };
  }, [open, popup]);

  const cancelDrag = useCallback(() => controller.current?.cancel() ?? false, []);
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && cancelDrag()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || controller.current?.isActive()) return;
    const step = event.shiftKey ? 24 : 8;
    const moves: Record<string, readonly [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (event.key === "Home" || moves[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") placement.current?.center();
      else placement.current?.moveBy(...moves[event.key]);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("button, input, textarea, select, a, [contenteditable], [data-no-drag]")) return;
    controller.current?.pointerDown(event);
  };
  return {
    popupRef: setPopup, headerRef: header, cancelDrag, onKeyDownCapture,
    headerProps: {
      onPointerDown,
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => controller.current?.pointerMove(event),
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => controller.current?.pointerUp(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => controller.current?.pointerCancel(event),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => controller.current?.lostPointerCapture(event),
      onKeyDown: onHeaderKeyDown,
      onDoubleClick: () => placement.current?.center(),
    },
  };
}
