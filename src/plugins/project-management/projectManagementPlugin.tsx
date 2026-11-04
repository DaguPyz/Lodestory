import type {Plugin} from "@lodestory/sdk";
import {documentsKey, documentCreateRequested, documentRevealRequested, projectDocumentCatalogKey} from "@lodestory/sdk/documents";
import {layoutKey} from "@lodestory/sdk/layout";
import {uiKey} from "@lodestory/sdk/ui";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {shortcutsKey, shortcutCommandIds, shortcutScopeIds} from "@lodestory/sdk/shortcuts";
import {projectSearchKey, type ProjectSearchRecord} from "@lodestory/sdk/project-search";
import {createProjectManagementModel, type ProjectManagementModel, type ProjectTreeEntry} from "./projectManagementModel";
import {ProjectFiles, ProjectDialogs} from "./ProjectManagementView";
import "./project-management.css";

/** Owns the current project's files UI and creation interaction; document data stays in documents. */
export function createProjectManagementPlugin(): Plugin {
    let cleanup: (() => Promise<void>) | undefined;
    return {
        id: "project-management", requires: [workbenchKey, documentsKey, layoutKey, uiKey, projectSearchKey, shortcutsKey], provides: [projectDocumentCatalogKey],
        activate(context) {
            const workbench = context.get(workbenchKey);
            const documents = context.get(documentsKey);
            const layout = context.get(layoutKey);
            const ui = context.get(uiKey);
            const search = context.get(projectSearchKey);
            const shortcuts = context.get(shortcutsKey);
            const models = new Map<string, ProjectManagementModel>();
            const removers: (() => void)[] = [];
            let removeParticipant: (() => Promise<void>) | undefined;
            let active = true;
            context.provide(projectDocumentCatalogKey, {getCatalog: sessionId => active ? models.get(sessionId) ?? null : null});
            const validCreateArgs = (args: unknown): args is {sessionId?: string; parentPath?: string; extension?: "txt" | "md" | "lode"} => {
                if (args === undefined) return true;
                if (!args || typeof args !== "object") return false;
                const value = args as Record<string, unknown>;
                return (value.sessionId === undefined || typeof value.sessionId === "string")
                    && (value.parentPath === undefined || typeof value.parentPath === "string")
                    && (value.extension === undefined || value.extension === "txt" || value.extension === "md" || value.extension === "lode");
            };
            const entryExists = (entries: readonly ProjectTreeEntry[], path: string): boolean => {
                for (const entry of entries) {
                    if (entry.path === path) return true;
                    if (entry.children && entryExists(entry.children, path)) return true;
                }
                return false;
            };
            const directoryExists = (entries: readonly ProjectTreeEntry[], path: string): boolean => path === ""
                || entries.some(entry => entry.path === path && !!entry.children)
                || entries.some(entry => !!entry.children && directoryExists(entry.children, path));
            const canCreate = (args: unknown): boolean => {
                if (!active || !validCreateArgs(args)) return false;
                const state = workbench.getSnapshot();
                const request = (args ?? {}) as {sessionId?: string; parentPath?: string};
                const sessionId = request.sessionId ?? state.session?.id;
                const model = sessionId ? models.get(sessionId) : undefined;
                if (!model || state.session?.id !== sessionId || !state.active || state.busy) return false;
                const snapshot = model.getSnapshot();
                return !snapshot.blocked && !snapshot.loading && !snapshot.openingPath && !snapshot.creating
                    && !snapshot.deleting && !snapshot.deletingPath && !snapshot.deletePath
                    && !snapshot.renaming && !snapshot.renamePath && !snapshot.dialogOpen
                    && directoryExists(snapshot.entries, request.parentPath ?? snapshot.selectedFolder);
            };
            const renameRequest = (args: unknown, target: EventTarget | null) => {
                const state = workbench.getSnapshot();
                if (!state.session || args !== undefined && (!args || typeof args !== "object")) return null;
                const request = args as {sessionId?: unknown; path?: unknown} | undefined;
                if (request?.sessionId !== undefined && request.sessionId !== state.session.id) return null;
                if (request?.sessionId !== undefined && typeof request.sessionId !== "string") return null;
                const path = request?.path !== undefined ? request.path
                    : target instanceof Element ? target.closest<HTMLElement>("[data-project-tree-path]")?.dataset.projectTreePath : undefined;
                if (typeof path !== "string" || !path) return null;
                const model = models.get(state.session.id);
                const snapshot = model?.getSnapshot();
                if (!active || !model || !state.active || state.busy || !snapshot || snapshot.blocked || snapshot.loading
                    || snapshot.openingPath || snapshot.creating || snapshot.deleting || snapshot.deletingPath
                    || snapshot.renaming || snapshot.renamePath || snapshot.dialogOpen || !entryExists(snapshot.entries, path)) return null;
                return {model, path};
            };
            try {
                removers.push(shortcuts.registerCommand({
                    id: shortcutCommandIds.newDocument, title: "新建文档", category: "项目",
                    enabled: ({args}) => canCreate(args),
                    run: ({args}) => {
                        if (!canCreate(args) || !validCreateArgs(args)) return;
                        const state = workbench.getSnapshot();
                        const sessionId = args?.sessionId ?? state.session?.id;
                        if (!sessionId) return;
                        models.get(sessionId)?.requestCreate(args?.parentPath, args?.extension);
                    },
                }));
                removers.push(shortcuts.registerBinding({id: "project-management.new-document", commandId: shortcutCommandIds.newDocument,
                    scopeId: shortcutScopeIds.workbench, keys: "Mod+N", allowInInput: true}));
                removers.push(shortcuts.registerCommand({
                    id: shortcutCommandIds.renameEntry, title: "重命名文件或文件夹", category: "项目",
                    enabled: ({args, target}) => !!renameRequest(args, target),
                    run: ({args, target}) => {
                        const request = renameRequest(args, target);
                        if (request) request.model.requestRename(request.path);
                    },
                }));
                removers.push(shortcuts.registerBinding({id: "project-management.rename-entry", commandId: shortcutCommandIds.renameEntry,
                    scopeId: shortcutScopeIds.projectTree, keys: "F2"}));
            } catch (error) {
                for (const remove of removers.splice(0).reverse()) remove();
                throw error;
            }
            cleanup = async () => {
                active = false;
                const errors: unknown[] = [];
                for (const remove of removers.splice(0).reverse()) {
                    try {
                        remove();
                    } catch (error) {
                        errors.push(error);
                    }
                }
                try {
                    await removeParticipant?.();
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length) throw Object.assign(new Error("Project management failed to stop."), {errors});
            };
            removers.push(context.on(documentCreateRequested, request => {
                if (!active || workbench.getSnapshot().session?.id !== request.sessionId) return;
                void shortcuts.execute(shortcutCommandIds.newDocument, request).catch(error => console.error("Could not execute new-document command.", error));
            }));
            removers.push(context.on(documentRevealRequested, request => {
                if (!active || workbench.getSnapshot().session?.id !== request.sessionId) return;
                models.get(request.sessionId)?.reconcileDocument(request.documentId);
            }));
            removeParticipant = workbench.registerParticipant({
                id: "project-management",
                label: "项目文件",
                async start(session) {
                    if (!active || models.has(session.id)) throw new Error(`Project files session '${session.id}' cannot be started.`);
                    const workspace = documents.getWorkspace(session.id);
                    if (!workspace) throw new Error(`Documents workspace is unavailable for session '${session.id}'.`);
                    const model = createProjectManagementModel(session, workbench, workspace);
                    try {
                        await model.ready();
                    } catch (error) {
                        model.dispose();
                        throw error;
                    }
                    models.set(session.id, model);
                    let removeSearch: (() => void) | undefined;
                    try {
                        removeSearch = search.registerSource(session.id, "project-files", {
                            title: "工程文件",
                            getSnapshot() {
                                const state = model.getSnapshot();
                                const records: ProjectSearchRecord[] = [];
                                function collect(entries: typeof state.entries) {
                                    for (const entry of entries) {
                                        if (entry.children) collect(entry.children);
                                        else records.push({id: entry.path, kind: "文件", title: entry.name, detail: entry.path, text: ""});
                                    }
                                }
                                collect(state.entries);
                                return {records, loading: state.loading, error: state.error};
                            },
                            subscribe(listener) {
                                let previous = model.getSnapshot();
                                return model.subscribe(() => {
                                    const next = model.getSnapshot();
                                    if (next.entries !== previous.entries || next.loading !== previous.loading || next.error !== previous.error) listener();
                                    previous = next;
                                });
                            },
                            open: path => model.openDocument(path),
                            refresh: () => model.refresh(),
                        });
                    } catch (error) { models.delete(session.id); model.dispose(); throw error; }
                    return {
                        dispose() {
                            try {
                                removeSearch?.();
                                model.dispose();
                            } finally {
                                if (models.get(session.id) === model) models.delete(session.id);
                            }
                        }
                    };
                },
            });
            removers.push(layout.registerContent({
                id: "project-management.files", title: "工程文件", role: "navigation",
                render: ({active: visible}) => <ProjectFiles workbench={workbench} models={models} shortcuts={shortcuts} active={visible}/>,
            }));
            removers.push(ui.addWrapper({
                id: "project-management.dialogs", order: 50,
                wrap: children => <>{children}<ProjectDialogs workbench={workbench} models={models}/></>,
            }));
        },
        async deactivate() {
            const stop = cleanup;
            cleanup = undefined;
            await stop?.();
        },
    };
}
