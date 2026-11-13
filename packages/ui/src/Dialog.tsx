import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { createContext, useCallback, useContext, useId, useLayoutEffect, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from "react";
import { Button, type ButtonProps } from "./Button.js";
import {useDialogPosition} from "./useDialogPosition.js";
import {useInteractionRef} from "./Interaction.js";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after Base UI completes the open or close transition. */
  onOpenChangeComplete?: (open: boolean) => void;
  title: string;
  /** Semantic width preset; the host viewport still constrains the rendered width. */
  size?: "regular" | "narrow" | "wide" | "large";
  /** Fill lets children scroll. Flush also removes body padding and separates the header. */
  bodyLayout?: "scroll" | "fill" | "flush";
  description?: ReactNode;
  /** Optional controls beside the draggable title. */
  headerActions?: ReactNode;
  children: ReactNode;
  /** Prevent user dismissal while the owning plugin is processing an operation. */
  busy?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
};

type Density = "comfortable" | "spacious" | "compact";

const DialogBusyContext = createContext(false);

/** Controlled modal shell. The owning plugin retains all form and operation state. */
export function Dialog({ open, onOpenChange, onOpenChangeComplete, title, size = "regular", bodyLayout = "scroll", description, headerActions, children, busy = false, initialFocus, finalFocus }: DialogProps) {
  const [density, setDensity] = useState<Density>("comfortable");
  const movement = useDialogPosition(open);
  const interactionRef = useInteractionRef<HTMLDivElement>(open, "dialog");
  const setPopupRef = useCallback((element: HTMLDivElement | null) => {
    movement.popupRef(element);
    if (!element) return;
    let release: ReturnType<typeof interactionRef>;
    try { release = interactionRef(element); }
    catch (error) { movement.popupRef(null); throw error; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { if (typeof release === "function") release(); }
      finally { movement.popupRef(null); }
    };
  }, [movement.popupRef, interactionRef]);
  const movementHint = useId();

  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;
    const value = document.activeElement?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity;
    setDensity(value === "spacious" || value === "compact" ? value : "comfortable");
  }, [open]);

  return (
    <DialogBusyContext.Provider value={busy}>
      <BaseDialog.Root open={open} modal disablePointerDismissal={busy} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape-key" && movement.cancelDrag()) {
          details.cancel();
          return;
        }
        if (!nextOpen && busy) {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className="ui-dialog-backdrop" />
          <BaseDialog.Popup ref={setPopupRef} className="ui-dialog" data-ui-dialog-size={size} data-ui-dialog-body-layout={bodyLayout === "scroll" ? undefined : bodyLayout} data-ui-density={density} aria-modal="true" aria-busy={busy || undefined} inert={!open}
            onKeyDownCapture={movement.onKeyDownCapture}
            initialFocus={initialFocus} finalFocus={finalFocus}>
            <div ref={movement.headerRef} className="ui-dialog-header" role="group" tabIndex={-1}
              aria-label={`移动弹框：${title}`} aria-describedby={movementHint} {...movement.headerProps}>
              <BaseDialog.Title className="ui-dialog-title">{title}</BaseDialog.Title>
              {headerActions != null && <div className="ui-dialog-header-actions" data-no-drag
                onDoubleClick={event => event.stopPropagation()}>{headerActions}</div>}
              <span id={movementHint} className="ui-dialog-move-hint">拖动标题移动；方向键移动，Shift 加速，Home 居中，拖动时按 Escape 取消。</span>
            </div>
            <div className="ui-dialog-body">
              {description != null && <BaseDialog.Description className="ui-dialog-description">{description}</BaseDialog.Description>}
              {children}
            </div>
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
