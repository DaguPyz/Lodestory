export type LayoutPanelPresence = Readonly<{
  id: string | null;
  phase: "hidden" | "entering" | "open" | "exiting";
  revision: number;
}>;

export const initialLayoutPanelPresence: LayoutPanelPresence = Object.freeze({
  id: null,
  phase: "hidden",
  revision: 0,
});

/** Presence owns only the pixels left behind by a closing overlay, never its active content. */
export function reconcileLayoutPanelPresence(
  previous: LayoutPanelPresence,
  currentId: string | null,
  animateOverlay: boolean,
): LayoutPanelPresence {
  if (currentId === null) {
    if (previous.id === null) return previous;
    if (!animateOverlay) return {id: null, phase: "hidden", revision: previous.revision + 1};
    if (previous.phase === "exiting") return previous;
    return {id: previous.id, phase: "exiting", revision: previous.revision + 1};
  }

  if (!animateOverlay) {
    if (previous.id === currentId && previous.phase === "open") return previous;
    return {id: currentId, phase: "open", revision: previous.revision + 1};
  }

  if (previous.id === null) return {id: currentId, phase: "entering", revision: previous.revision + 1};
  if (previous.id === currentId && previous.phase !== "exiting") return previous;
  return {id: currentId, phase: "open", revision: previous.revision + 1};
}

export function completeLayoutPanelEnter(previous: LayoutPanelPresence, revision: number): LayoutPanelPresence {
  if (previous.phase !== "entering" || previous.revision !== revision) return previous;
  return {id: previous.id, phase: "open", revision: previous.revision + 1};
}

export function completeLayoutPanelExit(previous: LayoutPanelPresence, revision: number): LayoutPanelPresence {
  if (previous.phase !== "exiting" || previous.revision !== revision) return previous;
  return {id: null, phase: "hidden", revision: previous.revision + 1};
}
