import { useSyncExternalStore } from "react";
import { getThemeSnapshot, subscribeTheme } from "./themeStore";

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
}

