import type {Plugin} from "@lodestory/sdk";
import {createErrorUiPlugin} from "../plugins/error-ui";
import {createUiPlugin} from "../plugins/ui";
import {createThemePlugin} from "../plugins/theme/themePlugin";
import {createBuiltinThemesPlugin} from "../plugins/builtin-themes";
import {createDefaultLayoutPlugin} from "../plugins/default-layout/defaultLayoutPlugin";
import {createContextMenuPlugin} from "../plugins/context-menu";
import {createWelcomePlugin} from "../plugins/welcome/welcomePlugin";
import {createEditorPlugin} from "../plugins/editor/editorPlugin";
import {createSettingsPlugin} from "../plugins/settings/settingsPlugin";

/** 应用选择哪些插件；启动和渲染流程不根据具体插件添加分支。 */
export function createAppPlugins(): readonly Plugin[] {
    return [
        createErrorUiPlugin(),
        createUiPlugin(),
        createThemePlugin(),
        createBuiltinThemesPlugin(),
        createContextMenuPlugin(),
        createDefaultLayoutPlugin(),
        createWelcomePlugin(),
        createEditorPlugin(),
        createSettingsPlugin(),
    ];
}
