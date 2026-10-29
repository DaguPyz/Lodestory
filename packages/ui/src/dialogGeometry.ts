import type {DialogPoint} from "./dialogDragController.js";

export type DialogViewport = Readonly<{x: number; y: number; width: number; height: number}>;
export type DialogSize = Readonly<{width: number; height: number}>;

/** Keep the dialog within the viewport margins, or anchor oversized dialogs at the safe top-left. */
export function constrainDialogPosition(
  point: DialogPoint,
  size: DialogSize,
  viewport: DialogViewport,
  margin = 16,
): DialogPoint {
  const horizontalMargin = Math.max(0, Math.min(margin, viewport.width / 2));
  const verticalMargin = Math.max(0, Math.min(margin, viewport.height / 2));
  const left = viewport.x + horizontalMargin;
  const top = viewport.y + verticalMargin;
  const right = viewport.x + viewport.width - horizontalMargin;
  const bottom = viewport.y + viewport.height - verticalMargin;

  return {
    x: Math.max(left, Math.min(point.x, Math.max(left, right - size.width))),
    y: Math.max(top, Math.min(point.y, Math.max(top, bottom - size.height))),
  };
}

/** Center the dialog in the current viewport, keeping oversized dialogs at its safe origin. */
export function centerDialogPosition(size: DialogSize, viewport: DialogViewport, margin = 16): DialogPoint {
  return constrainDialogPosition({
    x: viewport.x + (viewport.width - size.width) / 2,
    y: viewport.y + (viewport.height - size.height) / 2,
  }, size, viewport, margin);
}
