import type {Plugin} from "@lodestory/sdk";
import {appPages, type EditorPageParams} from "../../app/pages";
import {PageShell} from "../../components/PageShell";
import {EditorPage} from "./EditorPage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";
import {errorUiKey} from "@lodestory/sdk/error";
import {layoutKey, type LayoutContent} from "@lodestory/sdk/layout";
import {EditorActions, EditorMain, EditorNavigation, EditorStatus} from "./EditorContents";
import {ReferencePanel} from "./ReferencePanel";
import {editorContentIds} from "./editorContentIds";

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
    const removeContents: (() => void)[] = [];

    return {
        id: "editor",
        requires: [uiKey, themeKey, errorUiKey, layoutKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            const {ErrorBoundary} = context.get(errorUiKey);
            const layout = context.get(layoutKey);
            const contents: LayoutContent[] = [
                {id: editorContentIds.main, title: "正文编辑", role: "main", render: props => <EditorMain {...props}/>},
                {id: editorContentIds.navigation, title: "项目文件", role: "navigation", render: props => <EditorNavigation {...props}/>},
                {id: editorContentIds.auxiliary, title: "参考资料", role: "auxiliary", render: () => <ReferencePanel/>},
                {id: editorContentIds.actions, title: "项目操作", role: "actions", render: props => <EditorActions {...props}/>},
                {id: editorContentIds.status, title: "写作状态", role: "status", render: () => <EditorStatus/>},
            ];
            for (const content of contents) removeContents.push(layout.registerContent(content));
            removePage = ui.registerPage({
                id: appPages.editor,
                render: ({params, active}) => {
                    const {project} = editorParams(params);
                    return <ErrorBoundary><PageShell showBrowserTitlebar={false}>
                        <EditorPage
                            layout={layout}
                            key={`${project.id}:${project.path}`}
                            projectName={project.name}
                            projectPath={project.path}
                            active={active}
                            onBack={() => ui.back()}
                            onOpenSettings={() => ui.openPage(appPages.settings)}
                        />
                    </PageShell></ErrorBoundary>;
                },
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            try {
                remove?.();
            } finally {
                const errors: unknown[] = [];
                for (const dispose of removeContents.splice(0).reverse()) {
                    try { dispose(); } catch (error) { errors.push(error); }
                }
                if (errors.length) throw errors[0];
            }
        },
    };
}
