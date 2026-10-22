import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from "react";
import { Button, type ButtonProps } from "./Button.js";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Prevent user dismissal while the owning plugin is processing an operation. */
  busy?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
};

const DialogBusyContext = createContext(false);

/** Controlled modal shell. The owning plugin retains all form and operation state. */
export function Dialog({ open, onOpenChange, title, description, children, busy = false, initialFocus, finalFocus }: DialogProps) {
  return (
    <DialogBusyContext.Provider value={busy}>
      <BaseDialog.Root open={open} modal disablePointerDismissal={busy} onOpenChange={(nextOpen, details) => {
        if (!nextOpen && busy) {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className="ui-dialog-backdrop" />
          <BaseDialog.Popup className="ui-dialog" data-ui-density="comfortable" aria-modal="true" aria-busy={busy || undefined}
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
