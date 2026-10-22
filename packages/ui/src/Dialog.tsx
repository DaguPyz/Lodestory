import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { createContext, useContext, useLayoutEffect, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from "react";
import { Button, type ButtonProps } from "./Button.js";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after Base UI completes the open or close transition. */
  onOpenChangeComplete?: (open: boolean) => void;
  title: string;
  /** Semantic width preset; the host viewport still constrains the rendered width. */
  size?: "regular" | "narrow" | "wide" | "large";
  description?: ReactNode;
  children: ReactNode;
  /** Prevent user dismissal while the owning plugin is processing an operation. */
  busy?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
};

type Density = "comfortable" | "spacious" | "compact";

const DialogBusyContext = createContext(false);

/** Controlled modal shell. The owning plugin retains all form and operation state. */
export function Dialog({ open, onOpenChange, onOpenChangeComplete, title, size = "regular", description, children, busy = false, initialFocus, finalFocus }: DialogProps) {
  const [density, setDensity] = useState<Density>("comfortable");

  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;
    const value = document.activeElement?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity;
    setDensity(value === "spacious" || value === "compact" ? value : "comfortable");
  }, [open]);

  return (
    <DialogBusyContext.Provider value={busy}>
      <BaseDialog.Root open={open} modal disablePointerDismissal={busy} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={(nextOpen, details) => {
        if (!nextOpen && busy) {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className="ui-dialog-backdrop" />
          <BaseDialog.Popup className="ui-dialog" data-ui-dialog-size={size} data-ui-density={density} aria-modal="true" aria-busy={busy || undefined} inert={!open}
            initialFocus={initialFocus} finalFocus={finalFocus}>
            <BaseDialog.Title className="ui-dialog-title">{title}</BaseDialog.Title>
            {description != null && <BaseDialog.Description className="ui-dialog-description">{description}</BaseDialog.Description>}
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    </DialogBusyContext.Provider>
  );
}

export type DialogActionsProps = Omit<ComponentPropsWithoutRef<"div">, "className" | "style">;

export function DialogActions(props: DialogActionsProps) {
  return <div {...props} className="ui-dialog-actions" />;
}

export type DialogCloseProps = Omit<ButtonProps, "type">;

/** A non-submit button that participates in the modal's dismissal and focus lifecycle. */
export function DialogClose({ ref, disabled, ...props }: DialogCloseProps) {
  const busy = useContext(DialogBusyContext);
  return <BaseDialog.Close ref={ref} disabled={busy || disabled} render={<Button {...props} type="button" />} />;
}
