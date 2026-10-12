import type {Plugin} from "../../plugin-core";
import {appPages} from "../../app/pages";
import {ThemeSettingsPage} from "./ThemeSettingsPage";
import {themeKey} from "../theme/themeService";
import {uiKey} from "../ui";

/** 将外观设置页登记到通用 UI；主题状态由根级 ThemeProvider 提供。 */
export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey, themeKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            removePage = ui.registerPage({
                id: appPages.settings,
                render: ({active}) => <ThemeSettingsPage active={active} onBack={() => ui.back()}/>,
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
