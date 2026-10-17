import { useSyncExternalStore } from "react";
import type { DocumentWorkspace } from "./createDocumentWorkspace";

/** Subscribe to a project-owned workspace without taking ownership of its lifetime. */
export function useDocumentWorkspace(workspace: DocumentWorkspace) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  return {
    ...snapshot,
    open: workspace.open,
    openCreated: workspace.openCreated,
    close: workspace.close,
    select: workspace.select,
    update: workspace.update,
    save: workspace.save,
    saveAll: workspace.saveAll,
    clearError: workspace.clearError,
    dispose: workspace.dispose,
  };
}
