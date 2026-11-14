import type {AssetEditorPanel, AssetEditorService} from "@lodestory/sdk/asset-editor";

export function createAssetEditorPanels(commitRemoval: (remove: () => void) => void) {
  const listeners = new Set<() => void>();
  let panels: readonly AssetEditorPanel[] = Object.freeze([]);
  let alive = true;

  function publish(next: AssetEditorPanel[]) {
    panels = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); }
      catch (error) { console.error("Asset editor panel subscriber failed.", {error}); }
    }
  }

  const service: AssetEditorService = Object.freeze({
    getPanels: () => panels,
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    registerPanel(panel: AssetEditorPanel) {
      if (!alive) throw new Error("Asset editor is no longer active.");
      const {id, title, order = 0, View} = panel;
      if (typeof id !== "string" || !id.trim() || typeof title !== "string" || !title.trim()
        || !Number.isFinite(order) || typeof View !== "function") {
        throw new TypeError("Asset editor panel requires an ID, a title, a finite order, and a view.");
      }
      if (panels.some(entry => entry.id === id)) throw new Error(`Asset editor panel '${id}' is already registered.`);
      const entry = Object.freeze({id, title, order, View});
      publish([...panels, entry].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)));
      const remove = () => {
        if (!panels.includes(entry)) return;
        commitRemoval(() => publish(panels.filter(item => item !== entry)));
      };
      return Object.assign(remove, {associate() {}, check() {}, withdraw: remove});
    },
  });

  return {service, dispose() { alive = false; panels = Object.freeze([]); listeners.clear(); }};
}
