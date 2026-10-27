import type {Plugin} from "@lodestory/sdk";
import {documentsKey, documentRevealRequested, type DocumentsService} from "@lodestory/sdk/documents";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createDocumentWorkspace} from "./createDocumentWorkspace";
import {createDocumentFiles} from "./documentFiles";

type ManagedSession = {
  workspace: ReturnType<typeof createDocumentWorkspace>;
  leaving: boolean;
  disposed: boolean;
  disposal?: Promise<void>;
};

/** Owns document tab membership and selection; project storage owns byte buffers and persistence. */
export function createDocumentsPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    id: "documents", requires: [workbenchKey, projectStorageKey], provides: [documentsKey],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      const sessions = new Map<string, ManagedSession>();
      let alive = true;
      const service: DocumentsService = Object.freeze({
        getWorkspace(sessionId: string) {
          const session = sessions.get(sessionId);
          return alive && session && !session.disposed ? session.workspace.service : null;
        },
      });
      let removeParticipant: (() => Promise<void>) | undefined;
      let removeSubscription: (() => void) | undefined;
      cleanup = async () => {
        alive = false;
        removeSubscription?.();
        await removeParticipant?.();
        sessions.clear();
      };
      context.provide(documentsKey, service);
      removeSubscription = workbench.subscribe(() => {
        for (const session of sessions.values()) session.workspace.refreshBlocked();
      });
      removeParticipant = workbench.registerParticipant({
        id: "documents",
        label: "文稿",
        start(session) {
          if (!alive || sessions.has(session.id)) throw new Error(`Document session '${session.id}' cannot be started.`);
          const projectFiles = storage.getFiles(session.id);
          if (!projectFiles) throw new Error(`Project files for document session '${session.id}' are unavailable.`);
          const files = createDocumentFiles(projectFiles);
          let managed!: ManagedSession;
          const workspace = createDocumentWorkspace(files, {
            canMutate: () => {
              const state = workbench.getSnapshot();
              return alive && !managed?.disposed && !managed?.leaving && !state.busy && state.session?.id === session.id;
            },
            onReveal(documentId) {
              if (!alive || managed?.disposed || sessions.get(session.id) !== managed) return;
              void context.emit(documentRevealRequested, Object.freeze({sessionId: session.id, documentId}))
                .catch(error => console.error("Document presentation request failed.", {error}));
            },
          });
          managed = {workspace, leaving: false, disposed: false};
          sessions.set(session.id, managed);
          const refresh = () => workspace.refreshBlocked();
          const dispose = (): Promise<void> => {
            if (managed.disposal) return managed.disposal;
            managed.disposed = true;
            refresh();
            managed.disposal = (async () => {
              await workspace.dispose();
              if (sessions.get(session.id) === managed) sessions.delete(session.id);
            })();
            return managed.disposal;
          };
          return {
            async beforeLeave() {
              if (managed.disposed) return true;
              managed.leaving = true;
              refresh();
              try { return await workspace.beforeLeave(); }
              finally {
                managed.leaving = false;
                refresh();
              }
            },
            dispose,
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
