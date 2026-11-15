import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.js";
import { Icon } from "./Icon.js";

export type CanvasZoomControlsProps = Readonly<{
  zoom: number;
  disabled?: boolean;
  label?: string;
  onZoomChange(zoom: number): void;
  onResetZoom(): void;
  onResetView(): void;
  children?: ReactNode;
}>;

export function CanvasZoomControls({ zoom, disabled, label = "画布视图", onZoomChange, onResetZoom, onResetView, children }: CanvasZoomControlsProps) {
  const percentage = `${Math.round(zoom * 100)}%`;
  return <div className="canvas-controls" role="toolbar" aria-label={label}>
    <div className="canvas-zoom-controls">
      <IconButton label="缩小画布" disabled={disabled || zoom <= 0.25} onClick={() => onZoomChange(zoom / 1.25)}>
        <Icon name="minus" />
      </IconButton>
      <span className="canvas-zoom-value">
        <Button variant="ghost" title="恢复到 100%" aria-label={`画布缩放 ${percentage}，恢复到 100%`}
          disabled={disabled} onClick={onResetZoom}>{percentage}</Button>
      </span>
      <IconButton label="放大画布" disabled={disabled || zoom >= 4} onClick={() => onZoomChange(zoom * 1.25)}>
        <Icon name="plus" />
      </IconButton>
    </div>
    {children}
    <Button variant="ghost" disabled={disabled} onClick={onResetView}><Icon name="focus" />回到原点</Button>
  </div>;
}
