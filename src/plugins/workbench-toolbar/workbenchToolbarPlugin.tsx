import type {Plugin} from "@lodestory/sdk";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {uiKey} from "@lodestory/sdk/ui";
import {layoutKey} from "@lodestory/sdk/layout";
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
    requires: [workbenchKey, uiKey, layoutKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const ui = context.get(uiKey);
      const layout = context.get(layoutKey);
      removeParticipant = workbench.registerParticipant({
        id: "workbench-toolbar",
        label: "工具栏",
        start(session) {
          const model = createWorkbenchToolbarModel(session, workbench, ui, layout);
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
        render: ({active}) => <WorkbenchToolbar workbench={workbench} layout={layout} models={models} active={active}/>,
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
