import type {RootOptions} from "react-dom/client";
import type {Plugin} from "@lodestory/sdk";
import {createUiPlugin} from "../plugins/ui";
import {createThemePlugin} from "../plugins/theme/themePlugin";
import {createContextMenuPlugin} from "../plugins/context-menu";
import {createWelcomePlugin} from "../plugins/welcome/welcomePlugin";
import {createEditorPlugin} from "../plugins/editor/editorPlugin";
import {createSettingsPlugin} from "../plugins/settings/settingsPlugin";
import {appPages} from "./pages";

/** 应用选择哪些插件；启动和渲染流程不根据具体插件添加分支。 */
export function createAppPlugins(container: Element | DocumentFragment, rootOptions?: RootOptions): readonly Plugin[] {
    return [
        createUiPlugin(container, {initialPage: appPages.welcome, rootOptions}),
        createThemePlugin(),
        createContextMenuPlugin(),
        createWelcomePlugin(),
        createEditorPlugin(),
        createSettingsPlugin(),
    ];
}
