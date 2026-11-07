import type {LayoutContent, LayoutRole, LayoutSnapshot} from "@lodestory/sdk/layout";

const roles: readonly LayoutRole[] = ["main", "tabs", "navigation", "auxiliary", "actions", "status"];
type PanelRole = "navigation" | "auxiliary";
type Preference = "auto" | "open" | "closed";

/** 默认布局的目录和展示策略；不包含文档、文件树或其他业务知识。 */
export function createLayoutStore(commitRemoval: (remove: () => void) => void) {
  const entries = new Map<string, LayoutContent>();
  const listeners = new Set<() => void>();
  const selected = new Map<LayoutRole, string>();
  const preferences: Record<PanelRole, Preference> = {navigation: "auto", auxiliary: "auto"};
  const hidden = new Set<string>();
  let started = false;
  let alive = true;
  let navigationDocked = true;
  let auxiliaryDocked = true;
  let lastPanel: PanelRole = "navigation";
  let snapshot: LayoutSnapshot = Object.freeze({contents: Object.freeze([]), shownIds: Object.freeze([])});
  let state: Readonly<{snapshot: LayoutSnapshot; navigationDocked: boolean; auxiliaryDocked: boolean}>
    = Object.freeze({snapshot, navigationDocked, auxiliaryDocked});

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
    const panelShown = (role: PanelRole, docked: boolean) => preferences[role] !== "closed"
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
    if (!changed && state.navigationDocked === navigationDocked && state.auxiliaryDocked === auxiliaryDocked) return;
    state = Object.freeze({snapshot, navigationDocked, auxiliaryDocked});
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Layout subscriber failed.", {error}); }
    }
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
      // 固定描述，避免调用方修改对象绕过校验或影响排序。
      const entry = Object.freeze({id: content.id, title: content.title, icon: content.icon, role: content.role, order: content.order ?? 0, render: content.render});
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
        const remove = () => {
          entries.delete(entry.id);
          hidden.delete(entry.id);
          publish();
        };
        // The owner may release its services immediately after this returns.
        if (started) commitRemoval(remove);
        else remove();
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
