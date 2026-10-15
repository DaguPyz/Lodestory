import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ResolvedTheme, ThemeDefaults, ThemePreference, ThemeType } from "@lodestory/sdk/theme";
import { isThemeType } from "./resolveTheme";
import { createThemeManager, isThemePreference } from "./themeManager";

export const THEME_STORAGE_KEY = "lodestory.theme-preference";
const LEGACY_STORAGE_KEY = "lodestory.theme-mode";
const CHANNEL_NAME = "lodestory.appearance";
// 跨插件重挂载仍串行调用同一个原生窗口，避免旧请求晚完成后覆盖新外观。
let nativeQueue: Promise<void> = Promise.resolve();

/** 每次插件激活创建独立状态；配色由默认主题提供者注入。 */
export function createThemeStore(defaults: ThemeDefaults) {
  const defaultThemeIds = Object.freeze({ dark: defaults.dark.id, light: defaults.light.id });
  let stopSync: (() => void) | undefined;
  const defaultPreference: ThemePreference = { mode: "fixed", themeId: defaultThemeIds.dark };
  let channel: BroadcastChannel | null = null;
  let syncGeneration = 0;
  let syncing = false;

  function readSystemTheme(): ThemeType {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  const manager = createThemeManager([defaults.dark, defaults.light], defaultThemeIds, defaultPreference, readSystemTheme());
  function parsePreference(saved: string | null): ThemePreference {
    try {
      const value: unknown = JSON.parse(saved ?? "null");
      if (isThemePreference(value)) {
        manager.checkPreference(value, false);
        return value;
      }
    } catch { /* Ignore invalid preferences without preventing startup. */ }
    return defaultPreference;
  }
  function readPreference(): ThemePreference {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved !== null) return parsePreference(saved);
      // Migrate the old selection in memory; the next successful save writes the new format.
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === "light") return { mode: "fixed", themeId: defaultThemeIds.light };
      if (legacy === "system") return { mode: "system", lightThemeId: defaultThemeIds.light, darkThemeId: defaultThemeIds.dark };
    } catch { /* Storage is optional; the session can still switch themes. */ }
    return defaultPreference;
  }
  manager.setPreference(readPreference());

  function applyDocumentTheme(theme: ResolvedTheme) {
    const root = document.documentElement;
    root.dataset.uiTheme = theme.type;
    root.dataset.uiThemeId = theme.id;
    for (const [name, value] of Object.entries(theme.cssVariables)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.type;
    root.style.removeProperty("background-color");
  }
  const getThemeSnapshot = manager.getSnapshot;
  const subscribeTheme = manager.subscribe;
  const registerTheme = manager.registerTheme;

  // Only the native appearance depends on light/dark; DOM colors always follow the theme ID.
  function nativeAppearance() {
    const { preference, theme } = manager.getSnapshot();
    return preference.mode === "system" ? null : theme.type;
  }
  let appliedTheme = getThemeSnapshot().theme;
  let appliedNativeAppearance = nativeAppearance();
  applyDocumentTheme(appliedTheme);
  const unsubscribeDocument = manager.subscribe(() => {
    const theme = getThemeSnapshot().theme;
    if (theme !== appliedTheme) {
      appliedTheme = theme;
      applyDocumentTheme(theme);
    }
    const appearance = nativeAppearance();
    if (appearance !== appliedNativeAppearance) {
      appliedNativeAppearance = appearance;
      if (syncing) syncWindowTheme();
    }
  });

  // Serialize native calls and invalidate obsolete completions, including after unmount.
  function syncWindowTheme() {
    if (!isTauri() || !syncing) return;
    const generation = ++syncGeneration;
    const appearance = nativeAppearance();
    nativeQueue = nativeQueue.then(async () => {
      if (!syncing || generation !== syncGeneration) return;
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setTheme(appearance);
        if (!syncing || generation !== syncGeneration) return;
        if (appearance === null) {
          const actual = await appWindow.theme();
          if (!syncing || generation !== syncGeneration) return;
          manager.setSystemType(isThemeType(actual) ? actual : readSystemTheme());
        }
        manager.setErrors({ windowError: false });
      } catch {
        if (syncing && generation === syncGeneration) manager.setErrors({ windowError: true });
      }
    });
  }

  function receivePreference(preference: ThemePreference, persistenceError = false) {
    manager.setPreference(preference, { persistenceError });
  }
  function savePreference(preference: ThemePreference) {
    let persistenceError = false;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preference));
    } catch {
      persistenceError = true;
    }
    receivePreference(preference, persistenceError);
    try {
      channel?.postMessage({ preference, persistenceError });
    } catch { /* Storage events still synchronize successfully saved choices. */ }
  }
  function setThemePreference(preference: ThemePreference) {
    manager.checkPreference(preference, true);
    savePreference(preference);
  }
  function retryTheme() {
    // Preserve an unavailable choice until its contributing plugin registers again.
    savePreference(getThemeSnapshot().preference);
    syncWindowTheme();
  }
  function whenNativeThemeReady() {
    return nativeQueue;
  }

  function startThemeSync() {
    stopSync?.();
    let disposed = false;
    let removeMediaListener: (() => void) | undefined;
    let unlistenNative: (() => void) | undefined;
    let localChannel: BroadcastChannel | null = null;
    syncing = true;
    // 先登记清理函数，平台 API 在初始化中抛错时也能释放已取得的资源。
    stopSync = () => {
      if (disposed) return;
      disposed = true;
      syncing = false;
      ++syncGeneration;
      removeMediaListener?.();
      window.removeEventListener("storage", handleStorage);
      unlistenNative?.();
      if (localChannel) localChannel.onmessage = null;
      localChannel?.close();
      if (channel === localChannel) channel = null;
    };

    function handleSystemChange() {
      manager.setSystemType(readSystemTheme());
    }
    function handleStorage(event: StorageEvent) {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch { return; }
      receivePreference(parsePreference(event.newValue));
    }
    try {
      const media = window.matchMedia("(prefers-color-scheme: light)");
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", handleSystemChange);
        removeMediaListener = () => media.removeEventListener("change", handleSystemChange);
      } else {
        media.addListener(handleSystemChange);
        removeMediaListener = () => media.removeListener(handleSystemChange);
      }
    } catch { /* A missing system appearance API uses the dark fallback. */ }
    window.addEventListener("storage", handleStorage);
    try {
      localChannel = new BroadcastChannel(CHANNEL_NAME);
      channel = localChannel;
      localChannel.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed) return;
        const data = event.data;
        if (typeof data !== "object" || data === null) return;
        const message = data as { preference?: unknown; persistenceError?: unknown };
        if (!isThemePreference(message.preference)) return;
        try {
          manager.checkPreference(message.preference, false);
          receivePreference(message.preference, message.persistenceError === true);
        } catch { /* A malformed preference from another window is ignored. */ }
      };
    } catch { /* Storage events work without BroadcastChannel. */ }
    if (isTauri()) {
      void getCurrentWindow().onThemeChanged(({ payload }) => {
        if (!disposed && getThemeSnapshot().preference.mode === "system" && isThemeType(payload)) manager.setSystemType(payload);
      }).then(unlisten => {
        if (disposed) unlisten();
        else unlistenNative = unlisten;
      }).catch(() => { /* The media query remains the system appearance fallback. */ });
    }
    handleSystemChange();
    syncWindowTheme();
    return stopSync;
  }

  return {
    getThemeSnapshot, subscribeTheme, registerTheme, setThemePreference, retryTheme,
    whenNativeThemeReady, startThemeSync,
    dispose() {
      try {
        stopSync?.();
      } finally {
        unsubscribeDocument();
      }
    },
  };
}
