export type MenuCloseReason = "dismiss" | "switch" | "action" | "lifecycle";

/** Window-local coordination; it holds no business state or DOM references. */
export function createMenuCoordinator() {
  let active: { id: string; close: (reason: MenuCloseReason) => void } | null = null;
  return {
    activate(id: string, close: (reason: MenuCloseReason) => void) {
      if (active?.id === id) return;
      const previous = active;
      active = { id, close };
      previous?.close("switch");
    },
    release(id: string) {
      if (active?.id === id) active = null;
    },
    closeAll(reason: MenuCloseReason = "lifecycle") {
      const previous = active;
      active = null;
      previous?.close(reason);
    },
  };
}
