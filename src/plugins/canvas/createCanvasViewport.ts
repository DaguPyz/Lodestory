import type {CanvasPoint, CanvasViewport, CanvasViewportSnapshot, CanvasZoomAnchor} from "@lodestory/sdk/canvas";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const finitePoint = (point: CanvasPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export function createCanvasViewport(
  initial: Readonly<{center?: CanvasPoint; zoom?: number}> = {},
  onDispose: () => void = () => {},
): CanvasViewport {
  const center = initial.center ?? {x: 0, y: 0};
  const zoom = initial.zoom ?? 1;
  if (!finitePoint(center) || !Number.isFinite(zoom) || zoom <= 0) throw new TypeError("Invalid canvas viewport.");
  let snapshot: CanvasViewportSnapshot = Object.freeze({center: Object.freeze({...center}), zoom: clampZoom(zoom), disposed: false});
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (error) { console.error("Canvas viewport subscriber failed.", {error}); }
    }
  }
  function update(nextCenter: CanvasPoint, nextZoom: number): boolean {
    if (snapshot.disposed || !finitePoint(nextCenter)
      || nextCenter.x === snapshot.center.x && nextCenter.y === snapshot.center.y && nextZoom === snapshot.zoom) return false;
    snapshot = Object.freeze({center: Object.freeze({...nextCenter}), zoom: nextZoom, disposed: false});
    notify();
    return true;
  }
  function zoomTo(value: number, anchor?: CanvasZoomAnchor) {
    if (snapshot.disposed || !Number.isFinite(value) || value <= 0) return false;
    const nextZoom = clampZoom(value);
    if (nextZoom === snapshot.zoom) return false;
    if (!anchor) return update(snapshot.center, nextZoom);
    if (!finitePoint(anchor.point) || !Number.isFinite(anchor.size.width) || !Number.isFinite(anchor.size.height)
      || anchor.size.width < 0 || anchor.size.height < 0) return false;
    const offset = {x: anchor.point.x - anchor.size.width / 2, y: anchor.point.y - anchor.size.height / 2};
    return update({
      x: snapshot.center.x + offset.x / snapshot.zoom - offset.x / nextZoom,
      y: snapshot.center.y + offset.y / snapshot.zoom - offset.y / nextZoom,
    }, nextZoom);
  }
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (snapshot.disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    panBy(x: number, y: number) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return update({x: snapshot.center.x - x / snapshot.zoom, y: snapshot.center.y - y / snapshot.zoom}, snapshot.zoom);
    },
    zoomTo,
    resetZoom: () => zoomTo(1),
    resetView: () => update({x: 0, y: 0}, 1),
    dispose() {
      if (snapshot.disposed) return;
      snapshot = Object.freeze({...snapshot, disposed: true});
      notify();
      listeners.clear();
      onDispose();
    },
  });
}
