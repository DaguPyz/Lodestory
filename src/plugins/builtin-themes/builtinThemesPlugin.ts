import type { Plugin } from "@lodestory/sdk";
import { themeDefaultsKey, type ThemeDefaults } from "@lodestory/sdk/theme";
import dark from "./dark.theme.json";
import light from "./light.theme.json";

/** 应用选择本插件提供默认配色；具体主题仍是统一目录中的普通项。 */
export const builtinThemeDefaults = Object.freeze({ dark, light }) as ThemeDefaults;

/** 只贡献默认配色数据；解析、选择、保存与平台同步均由主题管理器负责。 */
export function createBuiltinThemesPlugin(): Plugin {
  return {
    id: "builtin-themes",
    requires: [],
    provides: [themeDefaultsKey],
    activate(context) {
      context.provide(themeDefaultsKey, builtinThemeDefaults);
    },
  };
}
