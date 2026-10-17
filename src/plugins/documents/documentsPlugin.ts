import type {Plugin} from "@lodestory/sdk";
import {documentsKey, documentRevealRequested, type DocumentsService} from "@lodestory/sdk/documents";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createDocumentWorkspace} from "./createDocumentWorkspace";

/** Owns document buffers and persistence for each workbench session; has no UI or layout dependency. */
export function createDocumentsPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    id: "documents", requires: [workbenchKey], provides: [documentsKey],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const workspaces = new Map<string, ReturnType<typeof createDocumentWorkspace>>();
      let alive = true;
      const service: DocumentsService = Object.freeze({
        getWorkspace(sessionId: string) { return alive ? workspaces.get(sessionId)?.service ?? null : null; },
      });
      let removeParticipant: (() => Promise<void>) | undefined;
      let removeSubscription: (() => void) | undefined;
      cleanup = async () => {
        alive = false;
        removeSubscription?.();
        try { await removeParticipant?.(); }
        finally { workspaces.clear(); }
      };
      context.provide(documentsKey, service);
      removeSubscription = workbench.subscribe(() => {
        for (const workspace of workspaces.values()) workspace.refreshBlocked();
      });
      removeParticipant = workbench.registerParticipant({
        id: "documents",
        start(session) {
          if (!alive || workspaces.has(session.id)) throw new Error(`Document session '${session.id}' cannot be started.`);
          const workspace = createDocumentWorkspace(session.project.path, {
            canMutate: () => {
              const state = workbench.getSnapshot();
              return alive && !state.busy && state.session?.id === session.id;
            },
            onReveal(documentId) {
              if (!alive || workspaces.get(session.id) !== workspace) return;
              void context.emit(documentRevealRequested, Object.freeze({sessionId: session.id, documentId}))
                .catch(error => console.error("Document presentation request failed.", {error}));
            },
          });
          workspaces.set(session.id, workspace);
          return {
            beforeLeave: workspace.beforeLeave,
            async dispose() {
              try { await workspace.dispose(); }
              finally { if (workspaces.get(session.id) === workspace) workspaces.delete(session.id); }
            },
          };
        },
      });
    },
    async deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      await stop?.();
    },
  };
}
