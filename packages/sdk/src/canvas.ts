import type {ComponentType, ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";

export type CanvasPoint = Readonly<{x: number; y: number}>;
export type CanvasSize = Readonly<{width: number; height: number}>;
export type CanvasViewportSnapshot = Readonly<{
  /** World coordinate at the center of the visible surface. */
  center: CanvasPoint;
  /** 1 = 100%; supported range is 0.25–4. */
  zoom: number;
  disposed: boolean;
}>;
export type CanvasZoomAnchor = Readonly<{
  /** Surface-local CSS pixels, measured from its top-left corner. */
  point: CanvasPoint;
  size: CanvasSize;
}>;
export type CanvasViewport = {
  getSnapshot(): CanvasViewportSnapshot;
  subscribe(listener: () => void): () => void;
  /** Move the contents by this many CSS pixels; positive x/y moves them right/down. */
  panBy(x: number, y: number): boolean;
  /** Keep the world point under the anchor stationary; omitted anchor uses the surface center. */
  zoomTo(zoom: number, anchor?: CanvasZoomAnchor): boolean;
  /** Restore 100% while keeping the current world center. */
  resetZoom(): boolean;
  /** Restore world center (0, 0) and 100%. */
  resetView(): boolean;
  /** Stop notifications and reject further edits; the last snapshot remains readable. */
  dispose(): void;
};
export type CanvasSurfaceProps = Readonly<{
  /** One viewport is attached to one surface at a time. The caller owns its lifetime. */
  viewport: CanvasViewport;
  /** False ends gestures and disables input, without resetting the viewport. */
  active: boolean;
  label: string;
  /** Optional background guide; omitted uses dots. Business content stays in children. */
  grid?: "dots" | "none";
  /** Omit the zoom and reset toolbar when another view owns navigation. Defaults to true. */
  showControls?: boolean;
  /** Optional controls supplied by the consumer, placed beside the standard zoom controls. */
  zoomControls?: ReactNode;
  /** World-space content; this layer is translated and scaled by the surface. */
  children?: ReactNode;
}>;
export type CanvasService = {
  readonly Surface: ComponentType<CanvasSurfaceProps>;
  /** Independent in-memory view; contains no business data, file paths, or persistence. */
  createViewport(initial?: Readonly<{center?: CanvasPoint; zoom?: number}>): CanvasViewport;
};

/** Generic infinite-canvas navigation. Consumers own business content and viewport lifetimes. */
export const canvasKey = createServiceKey<CanvasService>("app/canvas");
