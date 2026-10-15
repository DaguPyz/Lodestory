import { useSyncExternalStore } from "react";
import { useThemeService } from "./ThemeProvider";

export function useTheme() {
  const service = useThemeService();
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
}

