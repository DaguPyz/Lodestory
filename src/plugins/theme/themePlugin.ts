import {createElement} from "react";
import type {Plugin} from "@lodestory/sdk";
import {uiKey} from "@lodestory/sdk/ui";
import {ThemeProvider} from "./ThemeProvider";
import {themeKey, type ThemeConfig, type ThemeService} from "@lodestory/sdk/theme";
import {createThemeStore} from "./themeStore";
import themeConfig from "./theme-config.json";

/** 主题管理插件：提供平级主题目录、选择与同步；配色由独立主题数据提供。 */
export function createThemePlugin(config: ThemeConfig = themeConfig): Plugin {
    let stopThemeSync: (() => void) | undefined;
    let removeUiWrapper: (() => void) | undefined;

    return {
        id: "theme",
        requires: [uiKey],
        provides: [themeKey],

        activate(context) {
            // 先保存清理函数，后续初始化失败时 Core 仍能调用 deactivate 清理。
            const store = createThemeStore(config);
            stopThemeSync = store.dispose;

            const service: ThemeService = {
                getSnapshot: store.getThemeSnapshot,
                subscribe: store.subscribeTheme,
                registerTheme: store.registerTheme,
                setPreference: store.setThemePreference,
                retry: store.retryTheme,
            };
            context.provide(themeKey, service);
            removeUiWrapper = context.track(context.get(uiKey).addWrapper({
                id: "theme",
                order: 20,
                async prepare() {
                    store.startThemeSync();
                    await store.whenNativeThemeReady();
                },
                wrap: (children) => createElement(ThemeProvider, {service, children}),
            }));
        },

        deactivate() {
            const removeWrapper = removeUiWrapper;
            removeUiWrapper = undefined;
            // 先清空记录，使重复清理不会再次调用停止函数。
            const stop = stopThemeSync;
            stopThemeSync = undefined;
            try {
                removeWrapper?.();
            } finally {
                stop?.();
            }
        },
    };
}
