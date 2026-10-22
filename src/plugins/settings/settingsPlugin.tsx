import type {Plugin} from "@lodestory/sdk";
import {appPages} from "../../app/pages";
import {ThemeSettingsPage} from "./ThemeSettingsPage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";
import {configKey} from "@lodestory/sdk/config";
import {errorUiKey} from "@lodestory/sdk/error";

/** 将外观与动效设置页登记到通用 UI，并注入对应共享服务。 */
export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey, themeKey, errorUiKey, configKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            const themes = context.get(themeKey);
            const config = context.get(configKey);
            const {ErrorBoundary} = context.get(errorUiKey);
            removePage = ui.registerPage({
                id: appPages.settings,
                render: ({active}) => <ErrorBoundary><ThemeSettingsPage service={themes} config={config} active={active} onBack={() => ui.back()}/></ErrorBoundary>,
            });
        },

        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
