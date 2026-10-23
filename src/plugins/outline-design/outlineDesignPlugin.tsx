import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {Icon} from "@lodestory/ui";
import {OutlineDesignPanel} from "./OutlineDesignPanel";
import {createTimelineListFiles} from "./timelineListFiles";
import {createTimelineListModel} from "./timelineListModel";
import "./outline-design.css";

/** 大纲列表由本插件管理；本插件定义路径和 UTF-8 JSON 规则，项目存储只管理共享字节。 */
export function createOutlineDesignPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  let removeParticipant: (() => Promise<void>) | undefined;
  return {
    id: "outline-design",
    requires: [layoutKey, workbenchKey, contextMenuKey, projectStorageKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      const contextMenus = context.get(contextMenuKey);
      const storage = context.get(projectStorageKey);
      const models = new Map<string, ReturnType<typeof createTimelineListModel>>();
      let alive = true;

      removeParticipant = workbench.registerParticipant({
        id: "outline-design",
        async start(session) {
          if (!alive || models.has(session.id)) throw new Error(`Outline session '${session.id}' cannot be started.`);
          const projectFiles = storage.getFiles(session.id);
          if (!projectFiles) throw new Error(`Project storage for session '${session.id}' is unavailable.`);
          const files = createTimelineListFiles(projectFiles);
          const model = createTimelineListModel(files);
          models.set(session.id, model);
          try {
            await model.load();
          } catch (error) {
            model.dispose();
            if (models.get(session.id) === model) models.delete(session.id);
            throw error;
          }
          return {
            beforeLeave() {
              // A form draft has no persisted file yet; keep the session alive until it is created or canceled.
              return model.getSnapshot().createDraft === null;
            },
            dispose() {
              try { model.dispose(); }
              finally { if (models.get(session.id) === model) models.delete(session.id); }
            },
          };
        },
      });

      removeContent = layout.registerContent({
        id: "outline-design.navigation",
        title: "大纲设计",
        role: "navigation",
        order: 10,
        icon: <Icon name="outline"/>,
        render: ({active}) => <OutlineDesignPanel workbench={workbench} contextMenus={contextMenus} models={models} active={active}/>,
      });

      const removeRegisteredContent = removeContent;
      removeContent = () => {
        removeRegisteredContent?.();
        alive = false;
      };
    },
    async deactivate() {
      const errors: unknown[] = [];
      const removeView = removeContent;
      removeContent = undefined;
      try { removeView?.(); } catch (error) { errors.push(error); }
      const remove = removeParticipant;
      removeParticipant = undefined;
      try { await remove?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Outline design failed to stop."), {errors});
    },
  };
}
