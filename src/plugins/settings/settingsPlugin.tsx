import type {Plugin} from "@lodestory/sdk";
import {Icon} from "@lodestory/ui";
import {navigationLayoutKey} from "@lodestory/sdk/navigation-layout";
import {appPages} from "../../app/pages";
import {ThemeSettingsPage} from "./ThemeSettingsPage";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";
import {configKey} from "@lodestory/sdk/config";
import {errorUiKey} from "@lodestory/sdk/error";

/** 向导航布局登记设置页，注入主题和配置服务；返回行为交给 UI。 */
export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey, navigationLayoutKey, themeKey, errorUiKey, configKey],
        provides: [],

        activate(context) {
            const ui = context.get(uiKey);
            const themes = context.get(themeKey);
            const config = context.get(configKey);
            const {ErrorBoundary} = context.get(errorUiKey);
            removePage = context.get(navigationLayoutKey).registerPage({
                id: appPages.settings,
                navigation: {label: "设置", icon: <Icon name="settings" />, group: "secondary", order: 0},
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
