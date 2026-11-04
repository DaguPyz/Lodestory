import type {Plugin} from "@lodestory/sdk";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {uiKey} from "@lodestory/sdk/ui";
import {layoutKey} from "@lodestory/sdk/layout";
import {shortcutCommandIds, shortcutsKey} from "@lodestory/sdk/shortcuts";
import {settingsKey} from "@lodestory/sdk/settings";
import {WorkbenchToolbar, ToolbarRecovery} from "./WorkbenchToolbar";
import {workbenchToolbarId} from "./workbenchToolbarIds";
import {createWorkbenchToolbarModel, type WorkbenchToolbarModel} from "./workbenchToolbarModel";

/** 提供工作台工具栏，专注策略与所有顶部交互均在本插件内部。 */
export function createWorkbenchToolbarPlugin(): Plugin {
  const models = new Map<string, WorkbenchToolbarModel>();
  const removeViews: (() => void)[] = [];
  let removeParticipant: (() => Promise<void>) | undefined;
  return {
    id: "workbench-toolbar",
    requires: [workbenchKey, uiKey, layoutKey, shortcutsKey, settingsKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const ui = context.get(uiKey);
      const layout = context.get(layoutKey);
      const shortcuts = context.get(shortcutsKey);
      const settings = context.get(settingsKey);
      removeParticipant = workbench.registerParticipant({
        id: "workbench-toolbar",
        label: "工具栏",
        start(session) {
          const model = createWorkbenchToolbarModel(session, workbench, settings, layout);
          models.set(session.id, model);
          return {
            dispose() {
              try { model.dispose(); }
              finally { if (models.get(session.id) === model) models.delete(session.id); }
            },
          };
        },
      });
      removeViews.push(layout.registerContent({
        id: workbenchToolbarId,
        title: "工作台工具栏",
        role: "actions",
        render: ({active}) => <WorkbenchToolbar workbench={workbench} layout={layout} models={models} active={active} shortcuts={shortcuts}
          onSearch={sessionId => { void shortcuts.execute(shortcutCommandIds.projectSearch, {sessionId}).catch(error => console.error("Could not open project search.", error)); }}/>,
      }));
      removeViews.push(ui.addWrapper({
        id: "workbench-toolbar.recovery",
        order: 50,
        wrap: children => <>{children}<ToolbarRecovery workbench={workbench} layout={layout} models={models}/></>,
      }));
    },
    async deactivate() {
      const errors: unknown[] = [];
      for (const remove of removeViews.splice(0).reverse()) {
        try { remove(); } catch (error) { errors.push(error); }
      }
      const remove = removeParticipant;
      removeParticipant = undefined;
      try { await remove?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Workbench toolbar failed to stop."), {errors});
    },
  };
}
