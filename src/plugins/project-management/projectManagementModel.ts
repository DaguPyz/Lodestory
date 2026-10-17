import {isTauri} from "@tauri-apps/api/core";
import type {DocumentWorkspace} from "@lodestory/sdk/documents";
import type {WorkbenchService, WorkbenchSession} from "@lodestory/sdk/workbench";
import {listDocuments, projectFilesErrorMessage} from "./projectFilesApi";

export type ProjectTreeEntry = Readonly<{ path: string; name: string; children?: readonly ProjectTreeEntry[] }>;
export type ProjectManagementSnapshot = Readonly<{
    sessionId: string;
    projectName: string;
    entries: readonly ProjectTreeEntry[];
    loading: boolean;
    error: string | null;
    selectedFolder: string;
    dialogOpen: boolean;
    createError: string | null;
    creating: boolean;
    blocked: boolean;
    activeDocumentPath: string | null;
    openingPath: string | null;
}>;
export type ProjectManagementModel = {
    getSnapshot(): ProjectManagementSnapshot;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    selectFolder(path: string): boolean;
    openDocument(path: string): Promise<boolean>;
    requestCreate(parentPath?: string): boolean;
    create(parentPath: string, name: string): Promise<void>;
    closeCreateDialog(): boolean;
    reconcileDocument(documentId: string): void;
    dispose(): void;
};

function immutableEntries(entries: readonly ProjectTreeEntry[]): readonly ProjectTreeEntry[] {
    return Object.freeze(entries.map(entry => Object.freeze({
        path: entry.path, name: entry.name,
        ...(entry.children ? {children: immutableEntries(entry.children)} : {}),
    })));
}

function findEntry(entries: readonly ProjectTreeEntry[], path: string): ProjectTreeEntry | undefined {
    for (const entry of entries) {
        if (entry.path === path) return entry;
        if (entry.children) {
            const child = findEntry(entry.children, path);
            if (child) return child;
        }
    }
}

const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Directory and interaction state belong to this plugin, separately from document buffers. */
export function createProjectManagementModel(
    session: WorkbenchSession, workbench: WorkbenchService, workspace: DocumentWorkspace,
): ProjectManagementModel {
    const listeners = new Set<() => void>();
    const missingPaths = new Set<string>();
    let entries: readonly ProjectTreeEntry[] = Object.freeze([]);
    let loading = true;
    let error: string | null = null;
    let selectedFolder = "";
    let dialogOpen = false;
    let createError: string | null = null;
    let disposed = false;
    let readSequence = 0;
    let currentRefresh: Promise<void> | undefined;
    let refreshAgain = false;
    let removeWorkbench = () => {
    };
    let removeDocuments = () => {
    };
    let documentState = workspace.getSnapshot();
    let lastActiveId = documentState.activeId;
    let knownPaths = new Set(documentState.documents.map(document => document.path));

    function blocked() {
        const state = workbench.getSnapshot();
        return disposed || !isTauri() || state.session?.id !== session.id || !state.active || state.busy || documentState.blocked;
    }

    function makeSnapshot(): ProjectManagementSnapshot {
        return Object.freeze({
            sessionId: session.id, projectName: session.project.name, entries, loading, error, selectedFolder,
            dialogOpen, createError, creating: documentState.creating, blocked: blocked(),
            activeDocumentPath: documentState.documents.find(document => document.id === documentState.activeId)?.path ?? null,
            openingPath: documentState.openingPath,
        });
    }

    let snapshot = makeSnapshot();

    function publish() {
        if (disposed) return;
        const next = makeSnapshot();
        if (Object.keys(next).every(key => next[key as keyof ProjectManagementSnapshot] === snapshot[key as keyof ProjectManagementSnapshot])) return;
        snapshot = next;
        for (const listener of [...listeners]) {
            if (!listeners.has(listener)) continue;
            try {
                listener();
            } catch (cause) {
                console.error("Project files subscriber failed.", {error: cause});
            }
        }
    }

    function isDirectory(path: string) {
        return path === "" || !!findEntry(entries, path)?.children;
    }

    function ensurePath(path: string) {
        if (disposed || findEntry(entries, path) || missingPaths.has(path)) return;
        missingPaths.add(path);
        if (currentRefresh) refreshAgain = true;
        else void model.refresh();
    }

    const model: ProjectManagementModel = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            if (disposed) return () => {
            };
            const subscription = () => listener();
            listeners.add(subscription);
            return () => {
                listeners.delete(subscription);
            };
        },
        refresh() {
            if (disposed) return Promise.resolve();
            const sequence = ++readSequence;
            // Install the request before notifying subscribers, including synchronous reentry.
            const operation = Promise.resolve().then(async () => {
                if (disposed || sequence !== readSequence) return;
                try {
                    const records = await listDocuments(session.project.path);
                    if (!disposed && sequence === readSequence) {
                        entries = immutableEntries(records);
                        if (!isDirectory(selectedFolder)) selectedFolder = "";
                    }
                } catch (cause) {
                    if (!disposed && sequence === readSequence) error = projectFilesErrorMessage(cause);
                } finally {
                    if (!disposed && sequence === readSequence) {
                        loading = false;
                        currentRefresh = undefined;
                        const again = refreshAgain;
                        refreshAgain = false;
                        if (!again) missingPaths.clear();
                        publish();
                        if (again) void model.refresh();
                    }
                }
            });
            currentRefresh = operation;
            loading = true;
            error = null;
            publish();
            return operation;
        },
        selectFolder(path) {
            if (blocked() || !isDirectory(path)) return false;
            selectedFolder = path;
            publish();
            return true;
        },
        openDocument(path) {
            if (blocked()) return Promise.resolve(false);
            selectedFolder = parentOf(path);
            publish();
            return workspace.open(path);
        },
        requestCreate(parentPath = selectedFolder) {
            if (blocked() || documentState.creating || dialogOpen || !isDirectory(parentPath)) return false;
            selectedFolder = parentPath;
            createError = null;
            workspace.clearError();
            dialogOpen = true;
            publish();
            return true;
        },
        async create(parentPath, name) {
            if (blocked() || documentState.creating || !dialogOpen || !isDirectory(parentPath)) return;
            createError = null;
            workspace.clearError();
            publish();
            try {
                const created = await workspace.create(parentPath, name);
                if (disposed) return;
                if (!created) {
                    createError = workspace.getSnapshot().error ?? "未能创建文档，请重试。";
                    publish();
                    return;
                }
                dialogOpen = false;
                selectedFolder = parentOf(created.path);
                ensurePath(created.path);
                publish();
                // A read begun before creation may need one follow-up to include the new file.
                while (!disposed && currentRefresh) await currentRefresh;
            } catch (cause) {
                if (!disposed) {
                    createError = projectFilesErrorMessage(cause);
                    publish();
                }
            }
        },
        closeCreateDialog() {
            if (blocked() || documentState.creating || !dialogOpen) return false;
            dialogOpen = false;
            createError = null;
            workspace.clearError();
            publish();
            return true;
        },
        reconcileDocument(documentId) {
            if (disposed) return;
            const state = workspace.getSnapshot();
            if (state.activeId !== documentId) return;
            const document = state.documents.find(item => item.id === documentId);
            if (!document) return;
            selectedFolder = parentOf(document.path);
            ensurePath(document.path);
            publish();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            readSequence += 1;
            removeDocuments();
            removeWorkbench();
            listeners.clear();
            missingPaths.clear();
            snapshot = Object.freeze({...snapshot, dialogOpen: false, blocked: true});
        },
    };

    try {
        removeDocuments = workspace.subscribe(() => {
            if (disposed) return;
            documentState = workspace.getSnapshot();
            if (documentState.activeId !== lastActiveId) {
                lastActiveId = documentState.activeId;
                const active = documentState.documents.find(document => document.id === lastActiveId);
                if (active) selectedFolder = parentOf(active.path);
            }
            const nextPaths = new Set(documentState.documents.map(document => document.path));
            for (const path of nextPaths) if (!knownPaths.has(path)) ensurePath(path);
            knownPaths = nextPaths;
            publish();
        });
        removeWorkbench = workbench.subscribe(() => {
            if (disposed) return;
            const state = workbench.getSnapshot();
            if (state.session?.id !== session.id || !state.active) dialogOpen = false;
            publish();
        });
        void model.refresh();
        return model;
    } catch (cause) {
        model.dispose();
        throw cause;
    }
}
