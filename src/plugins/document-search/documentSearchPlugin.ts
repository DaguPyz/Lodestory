import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey} from "@lodestory/sdk/body-editor";
import {documentsKey, projectDocumentCatalogKey} from "@lodestory/sdk/documents";
import {projectSearchKey} from "@lodestory/sdk/project-search";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createDocumentSearchSource} from "./documentSearchSource";

export function createDocumentSearchPlugin(): Plugin {
    let removeParticipant: (() => Promise<void>) | undefined;
    return {
        id: "document-search",
        requires: [workbenchKey, documentsKey, projectDocumentCatalogKey, bodyEditorKey, projectSearchKey],
        provides: [],
        activate(context) {
            const workbench = context.get(workbenchKey), documents = context.get(documentsKey);
            const catalogs = context.get(projectDocumentCatalogKey), editor = context.get(bodyEditorKey),
                search = context.get(projectSearchKey);
            removeParticipant = workbench.registerParticipant({
                id: "document-search", label: "正文搜索", start(session) {
                    const catalog = catalogs.getCatalog(session.id), workspace = documents.getWorkspace(session.id);
                    if (!catalog || !workspace) throw new Error("文档搜索所需的项目会话不可用。");
                    const derived = createDocumentSearchSource(session.id, catalog, workspace, editor);
                    let remove: (() => void) | undefined;
                    try {
                        remove = search.registerSource(session.id, "document-content", derived.source);
                    } catch (error) {
                        derived.dispose();
                        throw error;
                    }
                    return {
                        dispose() {
                            try {
                                remove?.();
                            } finally {
                                derived.dispose();
                            }
                        }
                    };
                }
            });
        },
        async deactivate() {
            const remove = removeParticipant;
            removeParticipant = undefined;
            await remove?.();
        },
    };
}
