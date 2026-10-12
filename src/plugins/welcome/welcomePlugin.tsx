import type {Plugin} from "@lodestory/sdk";
import {appPages, type EditorPageParams} from "../../app/pages";
import {WelcomePage} from "./WelcomePage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";

/** 欢迎页独立登记，项目打开成功后通过 UI 能力进入编辑页。 */
export function createWelcomePlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "welcome",
        requires: [uiKey, themeKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            removePage = ui.registerPage({
                id: appPages.welcome,
                render: ({active}) => <WelcomePage
                    active={active}
                    onOpenProject={(project) => ui.openPage(appPages.editor, {project} satisfies EditorPageParams)}
                    onOpenSettings={() => ui.openPage(appPages.settings)}
                />,
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
