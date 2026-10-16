import type { ResolvedTheme, ThemeConfig, ThemeDefinition, ThemePreference, ThemeSnapshot, ThemeType } from "@lodestory/sdk/theme";
import { resolveThemeDefinition } from "./resolveTheme";

export function isThemePreference(value: unknown): value is ThemePreference {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 144;
  if (p.mode === "fixed") return Object.keys(p).length === 2 && id(p.themeId);
  if (p.mode === "system") return Object.keys(p).length === 3 && id(p.lightThemeId) && id(p.darkThemeId);
  return false;
}

/** 纯主题目录与选择逻辑，不访问 DOM、存储或原生窗口。 */
export function createThemeManager(config: ThemeConfig, initialPreference: ThemePreference, initialSystemType: ThemeType) {
  const fallbackThemeIds = Object.freeze({ ...config.fallbackThemeIds });
  const defaultThemeId = config.defaultThemeId;
  let started = false;
  const themes = new Map<string, ResolvedTheme>();
  const listeners = new Set<() => void>();
  const rememberedTypes = new Map<string, ThemeType>();
  let systemType = initialSystemType;
  function add(definition: ThemeDefinition) {
    const theme = resolveThemeDefinition(definition);
    if (themes.has(theme.id)) throw new Error(`Theme '${theme.id}' is already registered.`);
    themes.set(theme.id, theme);
    rememberedTypes.set(theme.id, theme.type);
    return theme;
  }
  function checkPreference(preference: ThemePreference, requireAvailable: boolean) {
    if (!isThemePreference(preference)) throw new Error("Invalid theme preference.");
    const ids = preference.mode === "fixed" ? [preference.themeId] : [preference.lightThemeId, preference.darkThemeId];
    if (requireAvailable) for (const id of ids) if (!themes.has(id)) throw new Error(`Theme '${id}' is not registered.`);
    if (preference.mode === "system") for (const type of ["light", "dark"] as const) {
      const theme = themes.get(type === "light" ? preference.lightThemeId : preference.darkThemeId);
      if (theme && theme.type !== type) throw new Error(`System ${type} slot requires a ${type} theme.`);
    }
  }
  function selection(preference: ThemePreference) {
    const id = preference.mode === "fixed" ? preference.themeId : systemType === "light" ? preference.lightThemeId : preference.darkThemeId;
    const theme = themes.get(id);
    const type = preference.mode === "system" ? systemType : rememberedTypes.get(id) ?? "dark";
    const selected = theme && (preference.mode === "fixed" || theme.type === type) ? theme : null;
    const configured = themes.get(fallbackThemeIds[type]);
    const fallback = (configured?.type === type ? configured : undefined)
      ?? [...themes.values()].find(item => item.type === type)
      ?? themes.values().next().value ?? null;
    return { theme: started ? selected ?? fallback : null, unavailableThemeId: selected ? null : id };
  }

  checkPreference(initialPreference, false);
  let snapshot: ThemeSnapshot = Object.freeze({ preference: Object.freeze({ ...initialPreference }), ...selection(initialPreference), themes: Object.freeze([...themes.values()]), fallbackThemeIds, persistenceError: false, windowError: false });
  function update(patch: Partial<ThemeSnapshot> = {}, catalogChanged = false) {
    const preference = patch.preference ?? snapshot.preference;
    const next = { ...snapshot, ...patch, ...selection(preference), themes: catalogChanged ? Object.freeze([...themes.values()]) : snapshot.themes };
    if (next.preference === snapshot.preference && next.theme === snapshot.theme && next.themes === snapshot.themes && next.unavailableThemeId === snapshot.unavailableThemeId && next.persistenceError === snapshot.persistenceError && next.windowError === snapshot.windowError) return;
    snapshot = Object.freeze(next);
    listeners.forEach(listener => listener());
  }
  return {
    getSnapshot: () => snapshot,
    start() {
      if (started) return;
      if (!themes.has(defaultThemeId)) throw new Error(`Default theme '${defaultThemeId}' is not registered.`);
      for (const type of ["dark", "light"] as const) {
        if (themes.get(fallbackThemeIds[type])?.type !== type) throw new Error(`Missing ${type} fallback theme '${fallbackThemeIds[type]}'.`);
      }
      started = true;
      update();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    checkPreference,
    setPreference(preference: ThemePreference, errors: Partial<Pick<ThemeSnapshot, "persistenceError" | "windowError">> = {}) {
      checkPreference(preference, false);
      const next = JSON.stringify(preference) === JSON.stringify(snapshot.preference) ? snapshot.preference : Object.freeze({ ...preference });
      update({ preference: next, ...errors });
    },
    setSystemType(type: ThemeType) { systemType = type; update(); },
    setErrors(errors: Partial<Pick<ThemeSnapshot, "persistenceError" | "windowError">>) { update(errors); },
    registerTheme(definition: ThemeDefinition) {
      const theme = add(definition);
      update({}, true);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (themes.get(theme.id) !== theme) return;
        themes.delete(theme.id);
        update({}, true);
      };
    },
  };
}
