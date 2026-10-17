import { isTauri } from "@tauri-apps/api/core";
import { appPages } from "../../app/pages";
import { projectFilesErrorMessage, listDocuments, type TreeEntry } from "./projectFilesApi";
import type { DocumentWorkspace } from "@lodestory/sdk/documents";
import type { LayoutService } from "@lodestory/sdk/layout";
import type { WorkbenchService, WorkbenchSession } from "@lodestory/sdk/workbench";
import type { UiService } from "@lodestory/sdk/ui";
import { editorContentIds } from "./editorContentIds";

export type EditorModelSnapshot = Readonly<{
  projectName: string;
  projectPath: string;
  entries: readonly EditorTreeEntry[];
  treeLoading: boolean;
  treeError: string | null;
  selectedFolder: string;
  createDialogOpen: boolean;
  createError: string | null;
  workspace: DocumentWorkspace;
}>;

export type EditorTreeEntry = Readonly<{
  path: string;
  name: string;
  children?: readonly EditorTreeEntry[];
}>;

export type EditorModel = {
  getSnapshot: () => EditorModelSnapshot;
  subscribe: (listener: () => void) => () => void;
  setSelectedFolder: (path: string) => void;
  /** 供插件级新建事件处理器调用，只负责显示已有新建交互。 */
  showNewDocument: (parentPath?: string) => void;
  /** 所有界面入口通过共享事件请求新建交互。 */
  requestNewDocument: (parentPath?: string) => void;
  reloadTree: () => Promise<void>;
  openDocument: (path: string) => Promise<boolean>;
  create: (parentPath: string, name: string) => Promise<void>;
  revealDocument: (id: string) => boolean;
  closeCreateDialog: () => void;
  leaveProject: () => Promise<boolean>;
  openSettings: () => Promise<boolean>;
  dispose: () => void;
};

function immutableEntries(entries: TreeEntry[]): readonly EditorTreeEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    ...(entry.children ? { children: immutableEntries(entry.children) } : {}),
  })));
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createEditorModel(
  session: WorkbenchSession,
  workbench: WorkbenchService,
  layout: LayoutService,
  ui: UiService,
  workspace: DocumentWorkspace,
  emitCreateRequest: (parentPath?: string) => Promise<void>,
): EditorModel {
  const listeners = new Set<() => void>();
  let entries: readonly EditorTreeEntry[] = Object.freeze([]);
  let treeLoading = true;
  let treeError: string | null = null;
  let selectedFolder = "";
  let createDialogOpen = false;
  let createError: string | null = null;
  let treeSequence = 0;
  let disposed = false;
  let snapshot: EditorModelSnapshot;

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Keep other subscribers responsive. */ }
    }
  };

  const publish = () => {
    if (disposed) return;
    snapshot = Object.freeze({
      projectName: session.project.name,
      projectPath: session.project.path,
      entries,
      treeLoading,
      treeError,
      selectedFolder,
      createDialogOpen,
      createError,
      workspace,
    });
    notify();
  };

  const canInteract = () => !disposed && !workspace.getSnapshot().blocked && !workbench.getSnapshot().busy;
  const safeShowMain = () => {
    try { layout.show(editorContentIds.main); } catch { /* Layout may already be shutting down. */ }
  };

  snapshot = Object.freeze({
    projectName: session.project.name,
    projectPath: session.project.path,
    entries,
    treeLoading,
    treeError,
    selectedFolder,
    createDialogOpen,
    createError,
    workspace,
  });

  const model: EditorModel = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    setSelectedFolder(path) {
      if (!canInteract()) return;
      selectedFolder = path;
      publish();
    },

    showNewDocument(parentPath = selectedFolder) {
      if (!canInteract() || !isTauri() || treeLoading || workspace.getSnapshot().creating) return;
      selectedFolder = parentPath;
      createError = null;
      workspace.clearError();
      createDialogOpen = true;
      safeShowMain();
      publish();
    },

    requestNewDocument(parentPath = selectedFolder) {
      if (!canInteract() || !isTauri() || treeLoading || workspace.getSnapshot().creating) return;
      void emitCreateRequest(parentPath).catch((cause) => {
        if (disposed) return;
        createError = failureMessage(cause);
        publish();
      });
    },

    async reloadTree() {
      if (disposed) return;
      const sequence = ++treeSequence;
      treeLoading = true;
      treeError = null;
      publish();
      try {
        const records = await listDocuments(session.project.path);
        if (!disposed && sequence === treeSequence) entries = immutableEntries(records);
      } catch (cause) {
        if (!disposed && sequence === treeSequence) treeError = projectFilesErrorMessage(cause);
      } finally {
        if (!disposed && sequence === treeSequence) {
          treeLoading = false;
          publish();
        }
      }
    },

    openDocument(path) {
      if (!canInteract()) return Promise.resolve(false);
      selectedFolder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      safeShowMain();
      publish();
      return workspace.open(path);
    },

    async create(parentPath, name) {
      if (!canInteract() || workspace.getSnapshot().creating) return;
      createError = null;
      workspace.clearError();
      publish();
      try {
        const created = await workspace.create(parentPath, name);
        if (disposed) return;
        if (!created) {
          createError = workspace.getSnapshot().error;
          publish();
          return;
        }
        createDialogOpen = false;
        selectedFolder = parentPath;
        safeShowMain();
        publish();
        await model.reloadTree();
      } catch (cause) {
        if (!disposed) {
          createError = failureMessage(cause);
          publish();
        }
      }
    },

    revealDocument(id) {
      if (disposed) return false;
      const state = workspace.getSnapshot();
      if (state.activeId !== id) return false;
      const document = state.documents.find((item) => item.id === id);
      if (!document) return false;
      selectedFolder = document.path.includes("/") ? document.path.slice(0, document.path.lastIndexOf("/")) : "";
      safeShowMain();
      publish();
      return true;
    },

    closeCreateDialog() {
      if (!canInteract() || workspace.getSnapshot().creating) return;
      createDialogOpen = false;
      createError = null;
      workspace.clearError();
      publish();
    },

    async leaveProject() {
      if (disposed) return false;
      const closed = await workbench.closeProject();
      if (!closed) safeShowMain();
      return closed;
    },

    async openSettings() {
      if (disposed) return false;
      const opened = await ui.openPage(appPages.settings);
      if (!opened) safeShowMain();
      return opened;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      treeSequence += 1;
      removeWorkbenchSubscription();
      listeners.clear();
    },
  };

  const removeWorkbenchSubscription = workbench.subscribe(() => {
    if (disposed) return;
    if (!workbench.getSnapshot().active) createDialogOpen = false;
    publish();
  });

  void model.reloadTree();
  return model;
}
