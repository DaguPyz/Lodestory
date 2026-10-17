import {isTauri} from "@tauri-apps/api/core";
import {appPages} from "../../app/pages";
import type {DocumentWorkspace} from "@lodestory/sdk/documents";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService, WorkbenchSession} from "@lodestory/sdk/workbench";
import type {UiService} from "@lodestory/sdk/ui";
import {editorContentIds} from "./editorContentIds";

export type EditorModelSnapshot = Readonly<{projectName: string; projectPath: string; workspace: DocumentWorkspace}>;
export type EditorModel = {
  getSnapshot(): EditorModelSnapshot;
  subscribe(listener: () => void): () => void;
  requestNewDocument(parentPath?: string): void;
  revealDocument(id: string): boolean;
  leaveProject(): Promise<boolean>;
  openSettings(): Promise<boolean>;
  dispose(): void;
};

/** Remaining editor presentation actions; directory and creation state belong to project-management. */
export function createEditorModel(
  session: WorkbenchSession, workbench: WorkbenchService, layout: LayoutService, ui: UiService,
  workspace: DocumentWorkspace, emitCreateRequest: (parentPath?: string) => Promise<void>,
): EditorModel {
  let disposed = false;
  const snapshot = Object.freeze({projectName: session.project.name, projectPath: session.project.path, workspace});
  const showMain = () => { try { layout.show(editorContentIds.main); } catch { /* The layout may be stopping. */ } };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    requestNewDocument(parentPath) {
      const state = workbench.getSnapshot();
      if (disposed || !isTauri() || state.session?.id !== session.id || !state.active || state.busy || workspace.getSnapshot().blocked) return;
      void emitCreateRequest(parentPath).catch(error => console.error("Could not request document creation.", {error}));
    },
    revealDocument(id) {
      if (disposed || workbench.getSnapshot().session?.id !== session.id) return false;
      const state = workspace.getSnapshot();
      if (state.activeId !== id || !state.documents.some(document => document.id === id)) return false;
      showMain();
      return true;
    },
    async leaveProject() {
      if (disposed) return false;
      const closed = await workbench.closeProject();
      if (!closed) showMain();
      return closed;
    },
    async openSettings() {
      if (disposed) return false;
      const opened = await ui.openPage(appPages.settings);
      if (!opened) showMain();
      return opened;
    },
    dispose() { disposed = true; },
  };
}
