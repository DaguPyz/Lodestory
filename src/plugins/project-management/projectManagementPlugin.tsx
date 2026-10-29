import type {Plugin} from "@lodestory/sdk";
import {documentsKey, documentCreateRequested, documentRevealRequested, projectDocumentCatalogKey} from "@lodestory/sdk/documents";
import {layoutKey} from "@lodestory/sdk/layout";
import {uiKey} from "@lodestory/sdk/ui";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {projectSearchKey, type ProjectSearchRecord} from "@lodestory/sdk/project-search";
import {createProjectManagementModel, type ProjectManagementModel} from "./projectManagementModel";
import {ProjectFiles, ProjectDialogs} from "./ProjectManagementView";
import "./project-management.css";

/** Owns the current project's files UI and creation interaction; document data stays in documents. */
export function createProjectManagementPlugin(): Plugin {
    let cleanup: (() => Promise<void>) | undefined;
    return {
        id: "project-management", requires: [workbenchKey, documentsKey, layoutKey, uiKey, projectSearchKey], provides: [projectDocumentCatalogKey],
        activate(context) {
            const workbench = context.get(workbenchKey);
            const documents = context.get(documentsKey);
            const layout = context.get(layoutKey);
            const ui = context.get(uiKey);
            const search = context.get(projectSearchKey);
            const models = new Map<string, ProjectManagementModel>();
            const removers: (() => void)[] = [];
            let removeParticipant: (() => Promise<void>) | undefined;
            let active = true;
            context.provide(projectDocumentCatalogKey, {getCatalog: sessionId => active ? models.get(sessionId) ?? null : null});
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
                models.get(request.sessionId)?.requestCreate(request.parentPath);
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
                render: ({active: visible}) => <ProjectFiles workbench={workbench} models={models} active={visible}/>,
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
