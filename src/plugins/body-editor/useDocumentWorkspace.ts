import { useCallback, useSyncExternalStore } from "react";
import type { DocumentWorkspace } from "@lodestory/sdk/documents";

/** Subscribe to the document plugin's session-owned workspace without taking ownership of its lifetime. */
export function useDocumentWorkspace(workspace: DocumentWorkspace) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const getSnapshot = useCallback(() => workspace.getSnapshot(), [workspace]);
  return {
    ...snapshot,
    getSnapshot,
    currentDocument: snapshot.documents.find((document) => document.id === snapshot.activeId),
    open: workspace.open,
    create: workspace.create,
    close: workspace.close,
    select: workspace.select,
    update: workspace.update,
    save: workspace.save,
    saveAs: workspace.saveAs,
    saveAll: workspace.saveAll,
    clearError: workspace.clearError,
  };
}
