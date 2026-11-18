import type {Plugin} from "@lodestory/sdk";
import {Icon} from "@lodestory/ui";
import {navigationLayoutKey} from "@lodestory/sdk/navigation-layout";
import {appPages} from "../../app/pages";
import {WelcomePage} from "./WelcomePage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {themeKey} from "@lodestory/sdk/theme";
import {errorUiKey} from "@lodestory/sdk/error";
import {i18nKey} from "@lodestory/sdk/i18n";

/** 向导航布局登记欢迎页；项目进入流程交给工作台能力。 */
export function createWelcomePlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "welcome",
        requires: [navigationLayoutKey, themeKey, errorUiKey, workbenchKey, i18nKey],
        provides: [],

        activate(context) {
            const navigation = context.get(navigationLayoutKey);
            const workbench = context.get(workbenchKey);
            const {ErrorBoundary} = context.get(errorUiKey);
            const i18n = context.get(i18nKey);
            removePage = context.track(navigation.registerPage({
                id: appPages.welcome,
                navigation: {label: "作品", icon: <Icon name="folder" />, group: "primary", order: 0},
                render: ({active}) => <ErrorBoundary><WelcomePage
                    active={active}
                    i18n={i18n}
                    onOpenProject={(project) => workbench.openProject(project)}
                /></ErrorBoundary>,
            }));
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
