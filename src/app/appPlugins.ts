import type {RootOptions} from "react-dom/client";
import type {Plugin} from "../plugin-core";
import {createUiPlugin} from "../plugins/ui";
import {createThemePlugin} from "../plugins/theme/themePlugin";
import {createContextMenuPlugin} from "../plugins/context-menu";
import {createAppPlugin} from "../plugins/app/appPlugin";

/** 应用选择哪些插件；启动和渲染流程不根据具体插件添加分支。 */
export function createAppPlugins(container: Element | DocumentFragment, rootOptions?: RootOptions): readonly Plugin[] {
    return [
        createUiPlugin(container, rootOptions),
        createThemePlugin(),
        createContextMenuPlugin(),
        createAppPlugin(),
    ];
}
