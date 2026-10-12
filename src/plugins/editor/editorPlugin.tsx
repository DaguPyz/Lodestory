import type {Plugin} from "@lodestory/sdk";
import {appPages, type EditorPageParams} from "../../app/pages";
import {PageShell} from "../../components/PageShell";
import {EditorPage} from "./EditorPage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";

function editorParams(params: unknown): EditorPageParams {
    const project = (params as Partial<EditorPageParams> | null)?.project;
    if (!project || !project.id || !project.path) {
        throw new TypeError("Editor page requires a project with an id, name, and path.");
    }
    return {project};
}

/** 编辑页持有项目内的状态；切到其他页面只隐藏，切换项目时重建编辑实例。 */
export function createEditorPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "editor",
        requires: [uiKey, themeKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            removePage = ui.registerPage({
                id: appPages.editor,
                render: ({params, active}) => {
                    const {project} = editorParams(params);
                    return <PageShell showBrowserTitlebar={false}>
                        <EditorPage
                            key={`${project.id}:${project.path}`}
                            projectName={project.name}
                            projectPath={project.path}
                            active={active}
                            onBack={() => ui.back()}
                            onOpenSettings={() => ui.openPage(appPages.settings)}
                        />
                    </PageShell>;
                },
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
