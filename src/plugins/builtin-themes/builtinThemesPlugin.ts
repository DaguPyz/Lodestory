import type { Plugin } from "@lodestory/sdk";
import { themeKey, type ThemeDefinition } from "@lodestory/sdk/theme";
import dark from "./dark.theme.json";
import light from "./light.theme.json";

/** 内置配色与其他主题贡献使用相同的登记、撤销和依赖关系。 */
export function createBuiltinThemesPlugin(): Plugin {
  const removers: (() => void)[] = [];
  return {
    id: "builtin-themes",
    requires: [themeKey],
    provides: [],
    activate(context) {
      const service = context.get(themeKey);
      // 逐项保留撤销函数，后续登记失败时也能清理已成功的贡献。
      for (const definition of [dark, light]) {
        removers.push(service.registerTheme(definition as ThemeDefinition));
      }
    },
    deactivate() {
      for (const remove of removers.splice(0).reverse()) remove();
    },
  };
}
