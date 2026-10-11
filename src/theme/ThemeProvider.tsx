import { createContext, useContext, type ReactNode } from "react";
import type { ThemeService } from "./themeService";

const ThemeContext = createContext<ThemeService | null>(null);

/** 传递主题插件提供的能力；不创建内核或启动主题同步。 */
export function ThemeProvider({ service, children }: { service: ThemeService; children: ReactNode }) {
  return <ThemeContext.Provider value={service}>{children}</ThemeContext.Provider>;
}

/** 页面从 Provider 取得主题插件传入的同一个主题能力。 */
export function useThemeService(): ThemeService {
  const service = useContext(ThemeContext);
  if (!service) throw new Error("ThemeService requires ThemeProvider at the window root.");
  return service;
}
