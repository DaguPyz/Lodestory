export type DialogPoint = Readonly<{x: number; y: number}>;

type CaptureTarget = Pick<HTMLElement, "setPointerCapture" | "releasePointerCapture" | "hasPointerCapture">;
type PointerInput = Pick<PointerEvent, "button" | "isPrimary" | "pointerId" | "clientX" | "clientY" | "preventDefault">;
type Drag = Readonly<{
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: DialogPoint;
}>;

const dragThreshold = 3;

function isFinitePoint(point: DialogPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Pointer-driven dialog movement; position ownership and viewport bounds stay with the UI host. */
export function createDialogDragController(options: {
  target: CaptureTarget;
  getPosition(): DialogPoint;
  constrain(point: DialogPoint): DialogPoint;
  setPosition(point: DialogPoint): void;
  onDraggingChange(dragging: boolean): void;
}) {
  let disposed = false;
  let drag: Drag | undefined;
  let dragging = false;

  function release(pointerId: number) {
    try {
      if (options.target.hasPointerCapture(pointerId)) options.target.releasePointerCapture(pointerId);
    } catch {
      // Capture can already be lost when the pointer leaves the window or the dialog closes.
    }
  }

  function finish(restore: boolean, notify = true) {
    const current = drag;
    if (!current) return false;
    drag = undefined;
    const wasDragging = dragging;
    dragging = false;
    release(current.pointerId);
    if (restore && wasDragging) {
      const position = options.constrain(current.startPosition);
      if (isFinitePoint(position)) options.setPosition(position);
    }
    if (notify && wasDragging) options.onDraggingChange(false);
    return true;
  }

  function pointerMove(event: PointerInput) {
    const current = drag;
    if (disposed || !current || event.pointerId !== current.pointerId
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;

    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!dragging && Math.hypot(dx, dy) <= dragThreshold) return;

    event.preventDefault();
    if (!dragging) {
      dragging = true;
      options.onDraggingChange(true);
    }

    const proposed = {x: current.startPosition.x + dx, y: current.startPosition.y + dy};
    const position = options.constrain(proposed);
    if (isFinitePoint(position)) options.setPosition(position);
  }

  return {
    pointerDown(event: PointerInput) {
      if (disposed || drag || event.button !== 0 || event.isPrimary === false
        || !Number.isFinite(event.pointerId) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const startPosition = options.getPosition();
      if (!isFinitePoint(startPosition)) return;
      try {
        options.target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      event.preventDefault();
      drag = {pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startPosition: {...startPosition}};
    },
    pointerMove,
    pointerUp(event: PointerInput) {
      if (disposed || !drag || event.pointerId !== drag.pointerId) return;
      pointerMove(event);
      finish(false);
    },
    pointerCancel(event: PointerInput) {
      if (!disposed && drag?.pointerId === event.pointerId) finish(true);
    },
    lostPointerCapture(event: PointerInput) {
      if (!disposed && drag?.pointerId === event.pointerId) finish(true);
    },
    cancel() {
      if (disposed) return false;
      return finish(true);
    },
    isActive() { return drag !== undefined; },
    dispose() {
      if (disposed) return;
      // Unmount releases capture without issuing position or React state updates to removed nodes.
      finish(false, false);
      disposed = true;
    },
  };
}
