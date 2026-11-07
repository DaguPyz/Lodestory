import type {Plugin} from "@lodestory/sdk";
import {documentsKey, documentRevealRequested, type DocumentsService} from "@lodestory/sdk/documents";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {shortcutsKey, shortcutCommandIds, shortcutScopeIds} from "@lodestory/sdk/shortcuts";
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
    id: "documents", requires: [workbenchKey, projectStorageKey, shortcutsKey], provides: [documentsKey],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      const shortcuts = context.get(shortcutsKey);
      const sessions = new Map<string, ManagedSession>();
      const registrations: (() => void)[] = [];
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
        const errors: unknown[] = [];
        for (const remove of registrations.splice(0).reverse()) {
          try { remove(); } catch (error) { errors.push(error); }
        }
        try { await removeParticipant?.(); } catch (error) { errors.push(error); }
        sessions.clear();
        if (errors.length) throw Object.assign(new Error("Documents failed to stop."), {errors});
      };
      context.provide(documentsKey, service);
      removeSubscription = workbench.subscribe(() => {
        for (const session of sessions.values()) session.workspace.refreshBlocked();
      });
      removeParticipant = context.track(workbench.registerParticipant({
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
      }));

      registrations.push(shortcuts.registerCommand({
        id: shortcutCommandIds.saveAll,
        title: "保存全部文稿",
        category: "文稿",
        enabled(invocation) {
          if (!alive) return false;
          const state = workbench.getSnapshot();
          const sessionId = state.session?.id;
          if (!state.active || state.busy || !sessionId
            || isTargetingAnotherSession(invocation.args, sessionId)) return false;
          const workspace = service.getWorkspace(sessionId);
          const snapshot = workspace?.getSnapshot();
          return !!workspace && !!snapshot && !snapshot.blocked && snapshot.documents.length > 0;
        },
        run(invocation) {
          const state = workbench.getSnapshot();
          const sessionId = state.session?.id;
          if (!state.active || state.busy || !sessionId
            || isTargetingAnotherSession(invocation.args, sessionId)) return false;
          const workspace = service.getWorkspace(sessionId);
          if (!workspace || workspace.getSnapshot().blocked) return false;
          return workspace.saveAll();
        },
      }));
      registrations.push(shortcuts.registerBinding({
        id: "documents.saveAll.default",
        commandId: shortcutCommandIds.saveAll,
        scopeId: shortcutScopeIds.workbench,
        keys: "Mod+S",
        allowInInput: true,
      }));
      registrations.push(shortcuts.registerCommand({
        id: shortcutCommandIds.closeDocument,
        title: "关闭当前文稿",
        category: "文稿",
        enabled(invocation) {
          if (!alive) return false;
          const state = workbench.getSnapshot();
          const sessionId = state.session?.id;
          if (!state.active || state.busy || !sessionId
            || isTargetingAnotherSession(invocation.args, sessionId)) return false;
          const workspace = service.getWorkspace(sessionId);
          const snapshot = workspace?.getSnapshot();
          const documentId = requestedDocumentId(invocation.args) ?? snapshot?.activeId;
          return !!snapshot && !snapshot.blocked && !!documentId
            && snapshot.documents.some(document => document.id === documentId);
        },
        run(invocation) {
          const state = workbench.getSnapshot();
          const sessionId = state.session?.id;
          if (!state.active || state.busy || !sessionId
            || isTargetingAnotherSession(invocation.args, sessionId)) return false;
          const workspace = service.getWorkspace(sessionId);
          const snapshot = workspace?.getSnapshot();
          const documentId = requestedDocumentId(invocation.args) ?? snapshot?.activeId;
          if (!workspace || !snapshot || snapshot.blocked || !documentId
            || !snapshot.documents.some(document => document.id === documentId)) return false;
          return workspace.close(documentId);
        },
      }));
      registrations.push(shortcuts.registerBinding({
        id: "documents.close.default",
        commandId: shortcutCommandIds.closeDocument,
        scopeId: shortcutScopeIds.document,
        keys: "Mod+W",
        allowInInput: true,
      }));
    },
    async deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      await stop?.();
    },
  };
}

function isTargetingAnotherSession(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const requested = (value as {sessionId?: unknown}).sessionId;
  return typeof requested === "string" && requested !== sessionId;
}

function requestedDocumentId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const documentId = (value as {documentId?: unknown}).documentId;
  return typeof documentId === "string" ? documentId : undefined;
}
