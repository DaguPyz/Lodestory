import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject} from "react";
import {createNavigationResizeController} from "./navigationResizeController";
import type {createNavigationWidthModel} from "./navigationWidth";

type WidthModel = ReturnType<typeof createNavigationWidthModel>;
type ElementRef = RefObject<HTMLElement | null>;

export function NavigationResizer({t, widths, root, workspace, rail, auxiliary, probe, enabled, docked, reserveAuxiliary}: {
  t: Translate;
  widths: WidthModel;
  root: ElementRef;
  workspace: ElementRef;
  rail: ElementRef;
  auxiliary: ElementRef;
  probe: ElementRef;
  enabled: boolean;
  docked: boolean;
  reserveAuxiliary: boolean;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createNavigationResizeController> | null>(null);
  const interactionEnabled = useRef(enabled);
  interactionEnabled.current = enabled;
  const [error, setError] = useState<string>();
  const snapshot = useSyncExternalStore(widths.subscribe, widths.getSnapshot, widths.getSnapshot);

  // 父节点和后续兄弟节点的 ref 在本组件的布局 effect 执行时尚未绑定。
  useEffect(() => {
    const target = handle.current;
    const layout = root.current;
    if (!target || !layout) return;
    const ownerDocument = target.ownerDocument;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      instance.keyDown(event);
    };
    const instance = createNavigationResizeController({
      target,
      getSnapshot: widths.getSnapshot,
      previewWidth: widths.previewWidth,
      commitWidth: () => { setError(undefined); return widths.commitWidth(); },
      cancelPreview: widths.cancelPreview,
      reset: () => { setError(undefined); return widths.reset(); },
      onError: () => setError("面板宽度未能保存，请重新调整后重试。"),
      onDraggingChange(dragging) {
        if (dragging) {
          layout.setAttribute("data-resizing-navigation", "true");
          target.setAttribute("data-dragging", "true");
          ownerDocument.addEventListener("keydown", onEscape, true);
        } else {
          layout.removeAttribute("data-resizing-navigation");
          target.removeAttribute("data-dragging");
          ownerDocument.removeEventListener("keydown", onEscape, true);
        }
      },
    });
    controller.current = instance;
    return () => {
      instance.dispose();
      if (controller.current === instance) controller.current = null;
      ownerDocument.removeEventListener("keydown", onEscape, true);
      layout.removeAttribute("data-resizing-navigation");
    };
  }, [widths, root]);

  useEffect(() => {
    const element = workspace.current;
    const defaultProbe = probe.current;
    if (!element || !defaultProbe) return;
    let previousAvailable = -1;
    let previousDefault = -1;
    const measure = () => {
      const total = element.getBoundingClientRect().width;
      const defaultWidth = defaultProbe.getBoundingClientRect().width;
      if (total <= 0 || defaultWidth <= 0) return;
      const availableWidth = Math.max(0, total - (rail.current?.getBoundingClientRect().width ?? 0)
        - (reserveAuxiliary ? auxiliary.current?.getBoundingClientRect().width ?? 0 : 0) - (docked ? 320 : 0));
      if (Math.abs(previousAvailable - availableWidth) < 0.5 && Math.abs(previousDefault - defaultWidth) < 0.5) return;
      controller.current?.cancel();
      previousAvailable = availableWidth;
      previousDefault = defaultWidth;
      widths.setEnvironment({availableWidth, defaultWidth});
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      observer.observe(defaultProbe);
      if (rail.current) observer.observe(rail.current);
      if (auxiliary.current) observer.observe(auxiliary.current);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [widths, workspace, rail, auxiliary, probe, docked, reserveAuxiliary]);

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const applyWidth = () => element.style.setProperty("--cmp-layout-user-navigation-width", `${widths.getSnapshot().effectiveWidth}px`);
    applyWidth();
    const unsubscribe = widths.subscribe(applyWidth);
    return () => {
      unsubscribe();
      element.style.removeProperty("--cmp-layout-user-navigation-width");
    };
  }, [widths, workspace]);

  useLayoutEffect(() => {
    if (!enabled) controller.current?.cancel();
  }, [enabled]);

  return <div ref={handle} className="layout-navigation-resizer" role="separator" tabIndex={enabled ? 0 : -1}
    aria-label={t("调整导航面板宽度")} aria-orientation="vertical"
    aria-valuemin={Math.round(snapshot.minWidth)} aria-valuemax={Math.round(snapshot.maxWidth)}
    aria-valuenow={Math.round(snapshot.effectiveWidth)} aria-valuetext={t("{value} 像素", {values: {value: Math.round(snapshot.effectiveWidth)}})}
    aria-disabled={!enabled || snapshot.minWidth === snapshot.maxWidth}
    title={t(error ?? "左右拖动调整宽度，双击恢复默认；方向键调整，Esc 取消拖动。")}
    onPointerDown={event => { if (interactionEnabled.current) controller.current?.pointerDown(event); }}
    onPointerMove={event => controller.current?.pointerMove(event)}
    onPointerUp={event => controller.current?.pointerUp(event)}
    onPointerCancel={event => controller.current?.pointerCancel(event)}
    onLostPointerCapture={event => controller.current?.lostPointerCapture(event)}
    onKeyDown={event => { if (interactionEnabled.current) controller.current?.keyDown(event); }}
    onDoubleClick={() => { if (interactionEnabled.current) controller.current?.doubleClick(); }}
  />;
}
import type {Translate} from "@lodestory/sdk/i18n";
