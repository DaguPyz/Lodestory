import { isTauri } from "@tauri-apps/api/core";
import { appPages } from "../../app/pages";
import { createDocumentWorkspace, type DocumentWorkspace } from "../../documents/createDocumentWorkspace";
import { createDocument, documentErrorMessage, listDocuments, type TreeEntry } from "../../documents/documentApi";
import type { LayoutService } from "@lodestory/sdk/layout";
import type { LeaveReason, WorkbenchService, WorkbenchSession } from "@lodestory/sdk/workbench";
import type { UiService } from "@lodestory/sdk/ui";
import { editorContentIds } from "./editorContentIds";

export type EditorModelSnapshot = Readonly<{
  projectName: string;
  projectPath: string;
  entries: readonly EditorTreeEntry[];
  treeLoading: boolean;
  treeError: string | null;
  newDisabled: boolean;
  selectedFolder: string;
  createDialogOpen: boolean;
  creating: boolean;
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
  showNewDocument: (parentPath?: string) => void;
  reloadTree: () => Promise<void>;
  openDocument: (path: string) => Promise<boolean>;
  create: (parentPath: string, name: string) => Promise<void>;
  closeCreateDialog: () => void;
  leaveProject: () => Promise<boolean>;
  openSettings: () => Promise<boolean>;
  beforeLeave: (reason: LeaveReason) => Promise<boolean>;
  dispose: () => Promise<void>;
};

function insertDocument(entries: TreeEntry[], path: string, name: string): TreeEntry[] {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!parent) return [...entries.filter((entry) => entry.path !== path), { path, name }];
  return entries.map((entry) => {
    if (!entry.children) return entry;
    if (entry.path === parent) return { ...entry, children: [...entry.children.filter((child) => child.path !== path), { path, name }] };
    return { ...entry, children: insertDocument(entry.children, path, name) };
  });
}

function immutableEntries(entries: TreeEntry[]): readonly EditorTreeEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    ...(entry.children ? { children: immutableEntries(entry.children) } : {}),
  })));
}

function mutableEntries(entries: readonly EditorTreeEntry[]): TreeEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    ...(entry.children ? { children: mutableEntries(entry.children) } : {}),
  }));
}

export function createEditorModel(
  session: WorkbenchSession,
  workbench: WorkbenchService,
  layout: LayoutService,
  ui: UiService,
): EditorModel {
  const listeners = new Set<() => void>();
  const pendingOpens = new Set<Promise<boolean>>();
  let entries: readonly EditorTreeEntry[] = Object.freeze([]);
  let treeLoading = true;
  let treeError: string | null = null;
  let selectedFolder = "";
  let createDialogOpen = false;
  let creating = false;
  let createError: string | null = null;
  let treeSequence = 0;
  let pendingCreate: Promise<void> | null = null;
  let checkingLeave = false;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let snapshot: EditorModelSnapshot;

  const workspace = createDocumentWorkspace(session.project.path, {
    canMutate: () => !disposed && !checkingLeave && !workbench.getSnapshot().busy,
  });

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
      newDisabled: !isTauri() || treeLoading || creating || checkingLeave || workbench.getSnapshot().busy,
      selectedFolder,
      createDialogOpen,
      creating,
      createError,
      workspace,
    });
    notify();
  };

  const safeShowMain = () => {
    try { layout.show(editorContentIds.main); } catch { /* Layout may already be shutting down. */ }
  };

  snapshot = Object.freeze({
    projectName: session.project.name,
    projectPath: session.project.path,
    entries,
    treeLoading,
    treeError,
    newDisabled: !isTauri() || treeLoading || creating || checkingLeave || workbench.getSnapshot().busy,
    selectedFolder,
    createDialogOpen,
    creating,
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
      if (disposed || checkingLeave || workbench.getSnapshot().busy) return;
      selectedFolder = path;
      publish();
    },

    showNewDocument(parentPath = selectedFolder) {
      if (disposed || checkingLeave || workbench.getSnapshot().busy || snapshot.newDisabled) return;
      selectedFolder = parentPath;
      createError = null;
      createDialogOpen = true;
      safeShowMain();
      publish();
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
        if (!disposed && sequence === treeSequence) treeError = documentErrorMessage(cause);
      } finally {
        if (!disposed && sequence === treeSequence) {
          treeLoading = false;
          publish();
        }
      }
    },

    openDocument(path) {
      if (disposed || checkingLeave || workbench.getSnapshot().busy) return Promise.resolve(false);
      selectedFolder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      safeShowMain();
      publish();
      const opening = workspace.open(path);
      pendingOpens.add(opening);
      void opening.finally(() => { pendingOpens.delete(opening); });
      return opening;
    },

    create(parentPath, name) {
      if (disposed || checkingLeave || workbench.getSnapshot().busy || pendingCreate) return pendingCreate ?? Promise.resolve();
      creating = true;
      createError = null;
      publish();
      const operation = (async () => {
        try {
          const record = await createDocument(session.project.path, parentPath, name);
          if (disposed) return;
          entries = immutableEntries(insertDocument(mutableEntries(entries), record.path, record.fileName));
          createDialogOpen = false;
          selectedFolder = parentPath;
          safeShowMain();
          workspace.openCreated(record, { internal: true });
          publish();
          await model.reloadTree();
        } catch (cause) {
          if (!disposed) {
            createError = documentErrorMessage(cause);
            publish();
          }
        } finally {
          if (!disposed) {
            creating = false;
            publish();
          }
        }
      })();
      pendingCreate = operation;
      void operation.finally(() => { if (pendingCreate === operation) pendingCreate = null; });
      return operation;
    },

    closeCreateDialog() {
      if (disposed || creating || checkingLeave || workbench.getSnapshot().busy) return;
      createDialogOpen = false;
      createError = null;
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

    async beforeLeave(_reason) {
      if (disposed) return true;
      if (checkingLeave) return false;
      checkingLeave = true;
      publish();
      try {
        const inFlight = [
          ...pendingOpens,
          ...(pendingCreate ? [pendingCreate] : []),
        ];
        await Promise.all(inFlight);
        if (disposed) return true;
        const allowed = await workspace.saveAll();
        if (!allowed) safeShowMain();
        return allowed;
      } finally {
        checkingLeave = false;
        publish();
      }
    },

    dispose() {
      if (disposal) return disposal;
      if (disposed) return Promise.resolve();
      disposed = true;
      treeSequence += 1;
      removeWorkbenchSubscription();
      listeners.clear();
      disposal = workspace.dispose();
      return disposal;
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
