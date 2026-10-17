import type {LayoutContent, LayoutService, LayoutSnapshot} from "@lodestory/sdk/layout";
import type {UiService} from "@lodestory/sdk/ui";
import type {WorkbenchService, WorkbenchSession} from "@lodestory/sdk/workbench";
import {appPages} from "../../app/pages";
import {workbenchToolbarId} from "./workbenchToolbarIds";

export type ToolbarSnapshot = Readonly<{
  focusMode: boolean;
  restoreIds: readonly string[];
}>;

export type WorkbenchToolbarModel = {
  getSnapshot(): ToolbarSnapshot;
  subscribe(listener: () => void): () => void;
  enterFocus(): boolean;
  exitFocus(): boolean;
  toggleContent(id: string): boolean;
  showToolbar(): boolean;
  leaveProject(): Promise<boolean>;
  openSettings(): Promise<boolean>;
  dispose(): void;
};

const isPanel = (entry: LayoutContent) => entry.role === "navigation" || entry.role === "auxiliary";
const visiblePanels = (snapshot: LayoutSnapshot) => new Set(snapshot.contents
  .filter(entry => isPanel(entry) && snapshot.shownIds.includes(entry.id)).map(entry => entry.id));

/** 专注只是本插件对公开显隐能力的组合，不读取默认布局内部状态。 */
export function createWorkbenchToolbarModel(
  session: WorkbenchSession,
  workbench: WorkbenchService,
  ui: UiService,
  layout: LayoutService,
): WorkbenchToolbarModel {
  let disposed = false;
  let applying = 0;
  let snapshot: ToolbarSnapshot = Object.freeze({focusMode: false, restoreIds: Object.freeze([])});
  let previousPanels = visiblePanels(layout.getSnapshot());
  const listeners = new Set<() => void>();

  function publish(focusMode: boolean, restoreIds: readonly string[] = []) {
    if (snapshot.focusMode === focusMode && snapshot.restoreIds.length === restoreIds.length
      && snapshot.restoreIds.every((id, index) => id === restoreIds[index])) return;
    snapshot = Object.freeze({focusMode, restoreIds: Object.freeze([...restoreIds])});
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (error) { console.error("Toolbar subscriber failed.", {error}); }
    }
  }

  function canInteract(requireToolbar = true) {
    const state = workbench.getSnapshot();
    return !disposed && state.session?.id === session.id && state.active && !state.busy
      && (!requireToolbar || layout.getSnapshot().shownIds.includes(workbenchToolbarId));
  }

  function apply(action: () => void) {
    applying += 1;
    try { action(); } finally { applying -= 1; }
  }

  function restoreFocus() {
    const ids = snapshot.restoreIds;
    publish(false);
    apply(() => {
      for (const id of ids) {
        const current = layout.getSnapshot();
        if (current.contents.some(entry => entry.id === id) && !current.shownIds.includes(id)) layout.show(id);
      }
    });
  }

  const stopLayout = layout.subscribe(() => {
    const current = visiblePanels(layout.getSnapshot());
    const added = [...current].some(id => !previousPanels.has(id));
    previousPanels = current;
    // 新的显隐结果可能来自其他入口或窗口变化，优先尊重该结果。
    if (!disposed && !applying && snapshot.focusMode && added) publish(false);
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    enterFocus() {
      if (!canInteract()) return false;
      if (snapshot.focusMode) return true;
      const ids = [...visiblePanels(layout.getSnapshot())];
      publish(true, ids);
      try {
        apply(() => {
          for (const id of ids) {
            if (disposed) break;
            layout.hide(id);
          }
        });
      } catch (error) {
        try { restoreFocus(); } catch (restoreError) { console.error("Could not restore panels after failed focus entry.", {error: restoreError}); }
        throw error;
      }
      return !disposed;
    },
    exitFocus() {
      if (!canInteract()) return false;
      restoreFocus();
      return true;
    },
    toggleContent(id) {
      if (!canInteract() || id === workbenchToolbarId) return false;
      const current = layout.getSnapshot();
      const entry = current.contents.find(content => content.id === id);
      if (!entry) return false;
      // 先记住用户点击时的意图，恢复旧面板后仍执行这次新的操作。
      const wasShown = current.shownIds.includes(id);
      if (snapshot.focusMode && isPanel(entry)) restoreFocus();
      apply(() => { if (wasShown) layout.hide(id); else layout.show(id); });
      return true;
    },
    showToolbar() {
      if (!canInteract(false) || !layout.getSnapshot().contents.some(entry => entry.id === workbenchToolbarId)) return false;
      layout.show(workbenchToolbarId);
      return true;
    },
    async leaveProject() {
      return canInteract() ? workbench.closeProject() : false;
    },
    async openSettings() {
      return canInteract() ? ui.openPage(appPages.settings) : false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLayout();
      listeners.clear();
      // dispose 在会话提交结束后执行，恢复布局不受新会话或 busy 状态限制。
      restoreFocus();
    },
  };
}
