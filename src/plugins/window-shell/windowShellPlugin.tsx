import type {Plugin} from "@lodestory/sdk";
import {windowShellKey, type WindowShellService} from "@lodestory/sdk/window-shell";
import {themeKey} from "@lodestory/sdk/theme";
import {PageShell} from "./PageShell";

/** 提供稳定的窗口外壳组件；组件资源由使用它的页面随 React 树管理。 */
export function createWindowShellPlugin(): Plugin {
    return {
        id: "window-shell",
        requires: [themeKey],
        provides: [windowShellKey],
        activate(context) {
            const service: WindowShellService = Object.freeze({View: PageShell});
            context.provide(windowShellKey, service);
        },
    };
}
