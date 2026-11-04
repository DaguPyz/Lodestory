import type { ComponentPropsWithRef } from "react";
import type { FocusSurface } from "./FocusSurface.js";

type NativeButtonProps = Omit<ComponentPropsWithRef<"button">, "className" | "style">;

type ButtonStateProps = {
  /** Whether the owning selection context is active; independent of keyboard focus. */
  selectionActive?: boolean;
  focusSurface?: FocusSurface;
};

export type ButtonProps = NativeButtonProps & ButtonStateProps & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

export function Button({ variant = "secondary", type = "button", selectionActive, focusSurface, ...props }: ButtonProps) {
  return <button {...props} type={type} className={`button button--${variant}`}
    data-selection-active={selectionActive} data-focus-surface={focusSurface} />;
}

export type IconButtonProps = Omit<NativeButtonProps, "aria-label" | "title"> & ButtonStateProps & {
  label: string;
  /** Optional longer hover hint, e.g. the action's current shortcut. Accessible name stays concise. */
  tooltip?: string;
};

export function IconButton({ label, tooltip, type = "button", selectionActive, focusSurface, ...props }: IconButtonProps) {
  return <button {...props} type={type} className="icon-button" aria-label={label} title={tooltip ?? label}
    data-selection-active={selectionActive} data-focus-surface={focusSurface} />;
}
