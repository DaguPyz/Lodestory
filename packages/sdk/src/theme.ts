import { createServiceKey } from "./ServiceKey.js";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type ThemeSnapshot = {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  persistenceError: boolean;
  windowError: boolean;
};

/** 主题服务的能力契约；具体实现由主题插件提供。 */
export type ThemeService = {
  /**
   * 读取当前主题状态，返回的 ThemeSnapshot 包含：
   * - mode：用户选择的模式，dark（深色）、light（浅色）或 system（跟随系统）。
   * - resolvedTheme：当前实际显示的主题，dark 或 light；跟随系统时由系统外观决定。
   * - persistenceError：主题偏好是否保存失败，true 表示未能保存。
   * - windowError：原生窗口外观是否同步失败，true 表示同步失败。
   * 状态不变时返回同一个快照对象。
   */
  getSnapshot(): ThemeSnapshot;
  /** 状态变化时通知监听者，返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /** 切换并保存主题模式；保存或窗口同步失败通过快照中的状态表达。 */
  setMode(mode: ThemeMode): void;
  /** 重试保存当前模式和同步窗口外观。 */
  retry(): void;
};

/** 主题插件和使用者共享此标识，用于注册、查找 ThemeService 的实现。 */
export const themeKey = createServiceKey<ThemeService>("app/theme");
