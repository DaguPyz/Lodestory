import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.js";
import { Icon } from "./Icon.js";

const defaultLabels = {
  toolbar: "画布视图",
  zoomOut: "缩小画布",
  zoomIn: "放大画布",
  resetZoom: "恢复到 100%",
  currentZoom: (percentage: string) => `画布缩放 ${percentage}，恢复到 100%`,
  resetView: "回到原点",
};

export type CanvasZoomControlsProps = Readonly<{
  zoom: number;
  disabled?: boolean;
  label?: string;
  labels?: typeof defaultLabels;
  onZoomChange(zoom: number): void;
  onResetZoom(): void;
  onResetView(): void;
  children?: ReactNode;
}>;

export function CanvasZoomControls({ zoom, disabled, label, labels = defaultLabels, onZoomChange, onResetZoom, onResetView, children }: CanvasZoomControlsProps) {
  const percentage = `${Math.round(zoom * 100)}%`;
  return <div className="canvas-controls" role="toolbar" aria-label={label ?? labels.toolbar}>
    <div className="canvas-zoom-controls">
      <IconButton label={labels.zoomOut} disabled={disabled || zoom <= 0.25} onClick={() => onZoomChange(zoom / 1.25)}>
        <Icon name="minus" />
      </IconButton>
      <span className="canvas-zoom-value">
        <Button variant="ghost" title={labels.resetZoom} aria-label={labels.currentZoom(percentage)}
          disabled={disabled} onClick={onResetZoom}>{percentage}</Button>
      </span>
      <IconButton label={labels.zoomIn} disabled={disabled || zoom >= 4} onClick={() => onZoomChange(zoom * 1.25)}>
        <Icon name="plus" />
      </IconButton>
    </div>
    {children}
    <Button variant="ghost" disabled={disabled} onClick={onResetView}><Icon name="focus" />{labels.resetView}</Button>
  </div>;
}
