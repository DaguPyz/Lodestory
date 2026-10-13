import type {Plugin} from "@lodestory/sdk";
import {appPages} from "../../app/pages";
import {ThemeSettingsPage} from "./ThemeSettingsPage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";
import {errorUiKey} from "@lodestory/sdk/error";

/** 将外观设置页登记到通用 UI；主题状态由根级 ThemeProvider 提供。 */
export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey, themeKey, errorUiKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            const {ErrorBoundary} = context.get(errorUiKey);
            removePage = ui.registerPage({
                id: appPages.settings,
                render: ({active}) => <ErrorBoundary><ThemeSettingsPage active={active} onBack={() => ui.back()}/></ErrorBoundary>,
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
