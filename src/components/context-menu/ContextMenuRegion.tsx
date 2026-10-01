import { ContextMenu } from "@base-ui/react/context-menu";
import type { BaseUIEvent } from "@base-ui/react/types";
import {
  useEffect, useId, useRef, useState, type MouseEvent, type ReactElement, type TouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { useContextMenus } from "./ContextMenuProvider";
import { findMenuAction, resolveMenu, type MenuConfig, type ResolvedEntry } from "./menuModel";
import type { MenuCloseReason } from "./menuCoordinator";
import "./context-menu.css";

export type ContextMenuRegionProps<T = undefined> = {
  /** The element must forward DOM props and its ref (React 19 supports ref as a prop). */
  children: ReactElement;
  items?: MenuConfig<T>;
  context?: T;
  mode?: "custom" | "native";
  disabled?: boolean;
  label?: string;
  density?: "comfortable" | "spacious" | "compact";
  onActionError?: (error: unknown) => void;
  fallbackFocus?: () => HTMLElement | null;
};

type Session<T> = { context: T; focus: HTMLElement; density: string };
const editableSelector = "input, textarea, [contenteditable]:not([contenteditable='false'])";
const focusableSelector = "button:not(:disabled), a[href], input, textarea, select, [tabindex]";

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

function Chevron() {
  return <svg className="context-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
}

export function ContextMenuRegion<T = undefined>(props: ContextMenuRegionProps<T>) {
  const { children, mode = "custom", disabled = false, label = "操作", items = [] } = props;
  const coordinator = useContextMenus();
  const id = useId();
  const trigger = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const session = useRef<Session<T> | null>(null);
  const restore = useRef(true);
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Session<T> | null>(null);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState(false);

  function close(reason: MenuCloseReason) {
    if (reason !== "dismiss") restore.current = false;
    setOpen(false);
    coordinator.release(id);
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; coordinator.release(id); };
  }, [coordinator, id]);

  useEffect(() => {
    if (disabled || mode === "native") {
      restore.current = false;
      setOpen(false);
      coordinator.release(id);
    }
  }, [disabled, mode, coordinator, id]);

  useEffect(() => {
    if (!open) return;
    function onScroll(event: Event) {
      // Only movement of this trigger's ancestors invalidates the pointer anchor.
      const target = event.target;
      if (target === document || target instanceof Element && target.contains(trigger.current)) close("lifecycle");
    }
    function onPointer(event: PointerEvent) {
      const target = elementOf(event.target);
      if (!target?.closest(`[data-context-menu-session='${id}']`)) close("switch");
    }
    function onContext(event: globalThis.MouseEvent) {
      const target = elementOf(event.target);
      if (!target?.closest(`[data-context-menu-session='${id}']`) && !trigger.current?.contains(target)) close("switch");
    }
    const observer = new MutationObserver(() => {
      const element = trigger.current;
      const modal = document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']:not([hidden])");
      if (!element?.isConnected || element.closest("[hidden], [inert]") || modal && !modal.contains(element)) close("lifecycle");
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-modal"] });
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("contextmenu", onContext, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("contextmenu", onContext, true);
    };
  }, [open, coordinator, id]);

  function prepare(target: Element | null) {
    const region = trigger.current;
    if (!region || disabled || mode === "native" || region.closest("[hidden], [inert]")) return false;
    const modal = document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']:not([hidden])");
    if (modal && !modal.contains(region)) return false;
    if (target?.closest("[data-context-menu-session]")) return false;
    const boundary = target?.closest("[data-context-menu-region]");
    if (boundary && boundary !== region) return false;
    const editable = target?.closest(editableSelector);
    if (editable && (editable !== region || latest.current.mode !== "custom")) return false;
    const context = latest.current.context as T;
    if (!resolveMenu(latest.current.items ?? [], context).length) return false;
    const focus = target?.closest<HTMLElement>(focusableSelector) ?? region.querySelector<HTMLElement>(focusableSelector) ?? region;
    const next = {
      context, focus,
      density: latest.current.density ?? region.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity ?? "comfortable",
    };
    session.current = next;
    restore.current = true;
    setSnapshot(next);
    return true;
  }

  function handleContext(event: BaseUIEvent<MouseEvent<HTMLDivElement>>) {
    event.stopPropagation();
    if (!prepare(elementOf(event.target))) {
      event.preventBaseUIHandler();
      coordinator.closeAll("switch");
    }
    // Base UI owns the pointer anchor and only cancels the native menu on a successful open.
  }

  function handleTouch(event: BaseUIEvent<TouchEvent<HTMLDivElement>>) {
    event.stopPropagation();
    if (!prepare(elementOf(event.target))) event.preventBaseUIHandler();
  }

  function reportError(error: unknown) {
    if (latest.current.onActionError) latest.current.onActionError(error);
    else if (alive.current) setActionError(true);
  }

  async function execute(path: string[]) {
    const current = session.current;
    const key = JSON.stringify(path);
    if (!current || pending.current.has(key) || latest.current.disabled || latest.current.mode === "native") return;
    const action = findMenuAction(resolveMenu(latest.current.items ?? [], current.context), path);
    if (!action || action.disabled) return;
    pending.current.add(key);
    setPendingKeys(new Set(pending.current));
    restore.current = action.restoreFocus !== false;
    setOpen(false);
    coordinator.release(id);
    try { await action.onSelect(current.context); }
    catch (error) { reportError(error); }
    finally {
      pending.current.delete(key);
      if (alive.current) setPendingKeys(new Set(pending.current));
    }
  }

  function renderEntries(entries: ResolvedEntry<T>[], parents: string[] = []): ReactElement[] {
    return entries.map((entry) => {
      const path = [...parents, entry.id];
      if (entry.type === "separator") return <ContextMenu.Separator key={entry.id} className="context-menu-separator" />;
      if (entry.type === "group") return <ContextMenu.Group key={entry.id}>
        {entry.label && <ContextMenu.GroupLabel className="context-menu-label">{entry.label}</ContextMenu.GroupLabel>}
        {renderEntries(entry.items, path)}
      </ContextMenu.Group>;
      const content = <>
        {entry.icon && <span className="context-menu-icon">{entry.icon}</span>}
        <span className="context-menu-item-label">{entry.label}</span>
        {entry.type === "submenu" ? <Chevron /> : entry.shortcut && <span className="context-menu-shortcut">{entry.shortcut}</span>}
      </>;
      if (entry.type === "submenu") return <ContextMenu.SubmenuRoot key={entry.id}>
        <ContextMenu.SubmenuTrigger className="context-menu-item" disabled={entry.disabled}>{content}</ContextMenu.SubmenuTrigger>
        <ContextMenu.Portal className="context-menu-portal" data-context-menu-session={id} data-ui-density={snapshot?.density}>
          <ContextMenu.Positioner className="context-menu-positioner" collisionPadding={16} sideOffset={4}>
            <ContextMenu.Popup className="context-menu-popup" aria-label={entry.label}>{renderEntries(entry.items, path)}</ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.SubmenuRoot>;
      return <ContextMenu.Item key={entry.id} className="context-menu-item" label={entry.label}
        disabled={entry.disabled || pendingKeys.has(JSON.stringify(path))} closeOnClick={false}
        onClick={() => void execute(path)}>{content}</ContextMenu.Item>;
    });
  }

  const entries = resolveMenu(items, (snapshot ? snapshot.context : props.context) as T);
  useEffect(() => {
    if (open && !entries.length) {
      restore.current = false;
      setOpen(false);
      coordinator.release(id);
    }
  }, [open, entries.length, coordinator, id]);
  return <>
    <ContextMenu.Root open={open} onOpenChange={(next, details) => {
      if (next) {
        if (!session.current || !resolveMenu(latest.current.items ?? [], session.current.context).length || disabled || mode === "native") { details.cancel(); return; }
        coordinator.activate(id, close);
      } else {
        if (details.reason !== "escape-key" && details.reason !== "item-press") restore.current = false;
        coordinator.release(id);
      }
      setOpen(next);
    }}>
      <ContextMenu.Trigger ref={trigger} render={children} data-context-menu-region={id}
        style={{ WebkitTouchCallout: "default" }}
        onContextMenu={handleContext} onTouchStart={handleTouch}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventBaseUIHandler();
          event.stopPropagation();
          const target = elementOf(event.target);
          if (!prepare(target)) return;
          event.preventDefault();
          const anchor = target ?? event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          anchor.dispatchEvent(new globalThis.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.bottom }));
        }} />
      <ContextMenu.Portal className="context-menu-portal" data-context-menu-session={id} data-ui-density={snapshot?.density}>
        <ContextMenu.Positioner className="context-menu-positioner" collisionPadding={16} sideOffset={4} alignOffset={0}>
          <ContextMenu.Popup className="context-menu-popup" aria-label={label}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onKeyDownCapture={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation();
            }}
            onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
            finalFocus={() => {
              if (!restore.current) return false;
              const target = session.current?.focus;
              return target?.isConnected && !target.closest("[hidden], [inert]") ? target : latest.current.fallbackFocus?.() ?? false;
            }}>
            {renderEntries(entries)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {actionError && createPortal(<div className="context-menu-action-error" role="alert">
      <span>操作失败，请重试。</span><button type="button" onClick={() => setActionError(false)}>关闭</button>
    </div>, document.body)}
  </>;
}
