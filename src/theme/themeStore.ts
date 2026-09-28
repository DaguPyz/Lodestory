import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type ThemeSnapshot = {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  persistenceError: boolean;
  windowError: boolean;
};

export const THEME_STORAGE_KEY = "lodestory.theme-mode";
const CHANNEL_NAME = "lodestory.appearance";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let nativeQueue: Promise<void> = Promise.resolve();

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return value === "dark" || value === "light";
}

function readThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(saved) ? saved : "dark";
  } catch {
    return "dark";
  }
}

function readSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(mode: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  return mode === "system" ? systemTheme : mode;
}

function applyDocumentTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.uiTheme = theme;
  root.style.colorScheme = theme;
  root.style.removeProperty("background-color");
}

const initialMode = readThemeMode();
let snapshot: ThemeSnapshot = {
  mode: initialMode,
  resolvedTheme: resolveTheme(initialMode, readSystemTheme()),
  persistenceError: false,
  windowError: false,
};
applyDocumentTheme(snapshot.resolvedTheme);

function updateSnapshot(patch: Partial<ThemeSnapshot>) {
  const next = { ...snapshot, ...patch };
  if (
    next.mode === snapshot.mode &&
    next.resolvedTheme === snapshot.resolvedTheme &&
    next.persistenceError === snapshot.persistenceError &&
    next.windowError === snapshot.windowError
  ) {
    return;
  }
  if (next.resolvedTheme !== snapshot.resolvedTheme) {
    applyDocumentTheme(next.resolvedTheme);
  }
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Serialize native calls so a slower earlier request cannot overwrite a newer choice.
function syncWindowTheme() {
  if (!isTauri()) return;

  const requestedMode = snapshot.mode;
  nativeQueue = nativeQueue.then(async () => {
    if (requestedMode !== snapshot.mode) return;
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setTheme(requestedMode === "system" ? null : requestedMode);
      if (requestedMode !== snapshot.mode) return;

      if (requestedMode === "system") {
        const actual = await appWindow.theme();
        if (snapshot.mode !== requestedMode) return;
        updateSnapshot({
          resolvedTheme: isResolvedTheme(actual) ? actual : readSystemTheme(),
          windowError: false,
        });
      } else {
        updateSnapshot({ windowError: false });
      }
    } catch {
      if (requestedMode === snapshot.mode) {
        updateSnapshot({ windowError: true });
      }
    }
  });
}

function receiveMode(mode: ThemeMode, persistenceError = false) {
  updateSnapshot({
    mode,
    resolvedTheme: resolveTheme(mode, readSystemTheme()),
    persistenceError,
  });
  syncWindowTheme();
}

export function setThemeMode(mode: ThemeMode) {
  if (!isThemeMode(mode)) return;

  let persistenceError = false;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    persistenceError = true;
  }
  receiveMode(mode, persistenceError);

  // Storage events cover saved preferences; the channel also shares a session-only choice.
  try {
    channel?.postMessage({ mode, persistenceError });
  } catch {
    // Live application changes still work if cross-window messaging is unavailable.
  }
}

export function retryTheme() {
  setThemeMode(snapshot.mode);
}

export function whenNativeThemeReady() {
  return nativeQueue;
}

export function startThemeSync() {
  let disposed = false;
  let media: MediaQueryList | null = null;
  let removeMediaListener: (() => void) | undefined;
  let unlistenNative: (() => void) | undefined;
  let localChannel: BroadcastChannel | null = null;

  function handleSystemChange() {
    if (snapshot.mode === "system") {
      updateSnapshot({ resolvedTheme: readSystemTheme() });
    }
  }

  function handleStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    receiveMode(isThemeMode(event.newValue) ? event.newValue : "dark");
  }

  try {
    media = window.matchMedia("(prefers-color-scheme: light)");
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleSystemChange);
      const observedMedia = media;
      removeMediaListener = () => observedMedia.removeEventListener("change", handleSystemChange);
    } else {
      media.addListener(handleSystemChange);
      const observedMedia = media;
      removeMediaListener = () => observedMedia.removeListener(handleSystemChange);
    }
  } catch {
    // A missing system appearance API resolves to the documented dark fallback.
  }

  window.addEventListener("storage", handleStorage);

  try {
    localChannel = new BroadcastChannel(CHANNEL_NAME);
    channel = localChannel;
    localChannel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { mode?: unknown; persistenceError?: unknown };
      if (isThemeMode(message.mode)) {
        receiveMode(message.mode, message.persistenceError === true);
      }
    };
  } catch {
    // Storage events remain available when BroadcastChannel is unsupported.
  }

  if (isTauri()) {
    void getCurrentWindow().onThemeChanged(({ payload }) => {
      if (!disposed && snapshot.mode === "system" && isResolvedTheme(payload)) {
        updateSnapshot({ resolvedTheme: payload });
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenNative = unlisten;
    }).catch(() => {
      // The media query listener remains the fallback for system appearance changes.
    });
  }

  handleSystemChange();
  syncWindowTheme();

  return () => {
    disposed = true;
    removeMediaListener?.();
    window.removeEventListener("storage", handleStorage);
    unlistenNative?.();
    localChannel?.close();
    if (channel === localChannel) channel = null;
  };
}
