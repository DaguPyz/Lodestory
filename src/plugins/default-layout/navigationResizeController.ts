type WidthSnapshot = Readonly<{effectiveWidth: number; minWidth: number; maxWidth: number}>;
type CaptureTarget = Pick<HTMLElement, "setPointerCapture" | "releasePointerCapture" | "hasPointerCapture">;
type PointerInput = Pick<PointerEvent, "button" | "isPrimary" | "pointerId" | "clientX" | "preventDefault">;
type KeyInput = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "preventDefault">;

export function createNavigationResizeController(options: {
  target: CaptureTarget;
  getSnapshot: () => WidthSnapshot;
  previewWidth: (width: number) => void;
  commitWidth: () => void | Promise<void>;
  cancelPreview: () => void;
  reset: () => void | Promise<void>;
  onError: (error: unknown) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  let disposed = false;
  let drag: {pointerId: number; startX: number; startWidth: number} | undefined;

  function clamp(width: number) {
    const {minWidth, maxWidth} = options.getSnapshot();
    return Math.min(maxWidth, Math.max(minWidth, width));
  }

  function report(action: () => void | Promise<void>) {
    try {
      void Promise.resolve(action()).catch(error => { if (!disposed) options.onError(error); });
    } catch (error) {
      if (!disposed) options.onError(error);
    }
  }

  function finish(commit: boolean) {
    const current = drag;
    if (!current) return;
    drag = undefined;
    try {
      if (options.target.hasPointerCapture(current.pointerId)) options.target.releasePointerCapture(current.pointerId);
    } catch {
      // The browser may already have released capture while hiding the panel.
    } finally {
      options.onDraggingChange(false);
    }
    if (commit && options.getSnapshot().effectiveWidth !== current.startWidth) report(options.commitWidth);
    else options.cancelPreview();
  }

  function pointerMove(event: PointerInput) {
    if (disposed || !drag || event.pointerId !== drag.pointerId || !Number.isFinite(event.clientX)) return;
    event.preventDefault();
    options.previewWidth(clamp(drag.startWidth + event.clientX - drag.startX));
  }

  return {
    pointerDown(event: PointerInput) {
      if (disposed) return;
      const {minWidth, maxWidth} = options.getSnapshot();
      if (drag || event.button !== 0 || event.isPrimary === false || maxWidth <= minWidth || !Number.isFinite(event.clientX)) return;
      event.preventDefault();
      try {
        options.target.setPointerCapture(event.pointerId);
      } catch (error) {
        options.onError(error);
        return;
      }
      drag = {pointerId: event.pointerId, startX: event.clientX, startWidth: options.getSnapshot().effectiveWidth};
      options.onDraggingChange(true);
    },
    pointerMove,
    pointerUp(event: PointerInput) {
      if (disposed || !drag || event.pointerId !== drag.pointerId) return;
      pointerMove(event);
      finish(true);
    },
    pointerCancel(event: PointerInput) {
      if (!disposed && drag?.pointerId === event.pointerId) finish(false);
    },
    lostPointerCapture(event: PointerInput) {
      if (!disposed && drag?.pointerId === event.pointerId) finish(false);
    },
    keyDown(event: KeyInput) {
      if (disposed) return;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finish(false);
        return;
      }
      if (drag || event.altKey || event.ctrlKey || event.metaKey) return;
      const {effectiveWidth, minWidth, maxWidth} = options.getSnapshot();
      const step = event.shiftKey ? 50 : 10;
      const next = event.key === "ArrowLeft" ? effectiveWidth - step
        : event.key === "ArrowRight" ? effectiveWidth + step
        : event.key === "Home" ? minWidth
        : event.key === "End" ? maxWidth : undefined;
      if (next === undefined) return;
      event.preventDefault();
      const width = clamp(next);
      if (width === effectiveWidth) return;
      options.previewWidth(width);
      report(options.commitWidth);
    },
    doubleClick() {
      if (disposed) return;
      finish(false);
      report(options.reset);
    },
    cancel() { if (!disposed) finish(false); },
    dispose() {
      if (disposed) return;
      finish(false);
      disposed = true;
    },
  };
}
