import type {Plugin} from "../plugin-core";
import {themeKey, type ThemeService} from "./themeService";
import {
    getThemeSnapshot,
    retryTheme,
    setThemeMode,
    startThemeSync,
    subscribeTheme,
    whenNativeThemeReady,
} from "./themeStore";

/** 创建主题插件；Core 挂载时启动同步，卸载或激活失败时停止同步。 */
export function createThemePlugin(): Plugin {
    let stopThemeSync: (() => void) | undefined;

    return {
        id: "theme",
        requires: [],
        provides: [themeKey],

        async activate(context) {
            // 先保存清理函数，后续初始化失败时 Core 仍能调用 deactivate 清理。
            stopThemeSync = startThemeSync();
            await whenNativeThemeReady();

            const service: ThemeService = {
                getSnapshot: getThemeSnapshot,
                subscribe: subscribeTheme,
                setMode: setThemeMode,
                retry: retryTheme,
            };
            context.provide(themeKey, service);
        },

        deactivate() {
            // 先清空记录，使重复清理不会再次调用停止函数。
            const stop = stopThemeSync;
            stopThemeSync = undefined;
            stop?.();
        },
    };
}
