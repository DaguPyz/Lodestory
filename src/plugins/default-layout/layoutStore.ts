import type {LayoutContent, LayoutRole, LayoutSnapshot} from "@lodestory/sdk/layout";

const roles: readonly LayoutRole[] = ["main", "navigation", "auxiliary", "actions", "status"];
type PanelRole = "navigation" | "auxiliary";
type Preference = "auto" | "open" | "closed";

/** 默认布局的目录和展示策略；不包含文档、文件树或其他业务知识。 */
export function createLayoutStore(beforeRemove: () => void) {
  const entries = new Map<string, LayoutContent>();
  const listeners = new Set<() => void>();
  const selected = new Map<LayoutRole, string>();
  const preferences: Record<PanelRole, Preference> = {navigation: "auto", auxiliary: "auto"};
  const hidden = new Set<string>();
  let started = false;
  let alive = true;
  let focusMode = false;
  let navigationDocked = true;
  let auxiliaryDocked = true;
  let lastPanel: PanelRole = "navigation";
  let snapshot: LayoutSnapshot = Object.freeze({contents: Object.freeze([]), shownIds: Object.freeze([])});
  let state: Readonly<{snapshot: LayoutSnapshot; focusMode: boolean; navigationDocked: boolean; auxiliaryDocked: boolean}>
    = Object.freeze({snapshot, focusMode, navigationDocked, auxiliaryDocked});

  function checkActive() {
    if (!alive) throw new Error("Layout service is no longer active.");
  }

  function publish() {
    const contents = [...entries.values()].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)
      || (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const role of roles) {
      if (!entries.has(selected.get(role) ?? "")) {
        const first = contents.find(entry => entry.role === role);
        if (first) selected.set(role, first.id); else selected.delete(role);
      }
    }
    const panelShown = (role: PanelRole, docked: boolean) => !focusMode && preferences[role] !== "closed"
      && (preferences[role] === "open" || docked);
    const shownIds = started ? contents.filter(entry => {
      if (entry.role === "actions" || entry.role === "status") return !hidden.has(entry.id);
      if (selected.get(entry.role) !== entry.id || hidden.has(entry.id)) return false;
      if (entry.role === "navigation") return panelShown("navigation", navigationDocked);
      if (entry.role === "auxiliary") return panelShown("auxiliary", auxiliaryDocked);
      return true;
    }).map(entry => entry.id) : [];
    const changed = contents.length !== snapshot.contents.length || contents.some((entry, i) => entry !== snapshot.contents[i])
      || shownIds.length !== snapshot.shownIds.length || shownIds.some((id, i) => id !== snapshot.shownIds[i]);
    if (changed) snapshot = Object.freeze({contents: Object.freeze(contents), shownIds: Object.freeze(shownIds)});
    if (!changed && state.focusMode === focusMode && state.navigationDocked === navigationDocked && state.auxiliaryDocked === auxiliaryDocked) return;
    state = Object.freeze({snapshot, focusMode, navigationDocked, auxiliaryDocked});
    for (const listener of [...listeners]) listener();
  }

  function getEntry(id: string) {
    checkActive();
    if (!started) throw new Error("Layout is not ready.");
    const entry = entries.get(id);
    if (!entry) throw new Error(`Layout content '${id}' is not registered.`);
    return entry;
  }

  function preventOverlayOverlap() {
    if (!navigationDocked && preferences.navigation === "open" && preferences.auxiliary === "open") {
      preferences[lastPanel === "navigation" ? "auxiliary" : "navigation"] = "closed";
    }
  }

  return {
    registerContent(content: LayoutContent) {
      checkActive();
      if (started) throw new Error("Layout contents must be registered before pluginsReady.");
      // 固定描述，避免调用方修改对象绕过校验或影响排序。
      const entry = Object.freeze({id: content.id, title: content.title, role: content.role, order: content.order ?? 0, render: content.render});
      if (typeof entry.id !== "string" || !entry.id.trim()) throw new TypeError("Layout content id cannot be empty.");
      if (typeof entry.title !== "string" || !entry.title.trim()) throw new TypeError("Layout content title cannot be empty.");
      if (!roles.includes(entry.role)) throw new TypeError("Unknown layout role.");
      if (!Number.isFinite(entry.order)) throw new TypeError("Layout content order must be finite.");
      if (typeof entry.render !== "function") throw new TypeError("Layout content must have a render function.");
      if (entries.has(entry.id)) throw new Error(`Layout content '${entry.id}' is already registered.`);
      entries.set(entry.id, entry);
      publish();
      return () => {
        if (!alive || entries.get(entry.id) !== entry) return;
        try {
          // 当前 UI 不支持运行中卸载贡献；先停止消费这些资源的整棵 UI 树。
          if (started) beforeRemove();
        } finally {
          entries.delete(entry.id);
          hidden.delete(entry.id);
          publish();
        }
      };
    },
    start() {
      checkActive();
      if (started) return;
      // 初始项按最终排序选择，与插件激活顺序无关。
      selected.clear();
      started = true;
      publish();
    },
    show(id: string) {
      const entry = getEntry(id);
      selected.set(entry.role, id);
      hidden.delete(id);
      if (entry.role === "navigation" || entry.role === "auxiliary") {
        focusMode = false;
        preferences[entry.role] = "open";
        lastPanel = entry.role;
        preventOverlayOverlap();
      }
      if (entry.role === "main") {
        if (!navigationDocked) preferences.navigation = "auto";
        if (!auxiliaryDocked) preferences.auxiliary = "auto";
      }
      publish();
    },
    hide(id: string) {
      getEntry(id);
      hidden.add(id);
      publish();
    },
    getSnapshot() { checkActive(); return snapshot; },
    getState() { checkActive(); return state; },
    subscribe(listener: () => void) {
      checkActive();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setViewport(width: number, rem: number) {
      checkActive();
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(rem) || rem <= 0) return;
      navigationDocked = width >= 54 * rem;
      auxiliaryDocked = width >= 74 * rem;
      preventOverlayOverlap();
      publish();
    },
    setFocusMode(value: boolean) { checkActive(); focusMode = value; publish(); },
    dispose() {
      if (!alive) return;
      alive = false;
      entries.clear();
      selected.clear();
      hidden.clear();
      listeners.clear();
    },
  };
}

export type LayoutStore = ReturnType<typeof createLayoutStore>;
