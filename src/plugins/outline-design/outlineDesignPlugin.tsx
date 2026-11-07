import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {timelineKey} from "@lodestory/sdk/timeline";
import {Icon} from "@lodestory/ui";
import {OutlineDesignPanel} from "./OutlineDesignPanel";
import "./outline-design.css";

/** 大纲只贡献时间线导航界面；时间线列表数据与业务流程由 timeline 插件拥有。 */
export function createOutlineDesignPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "outline-design",
    requires: [layoutKey, workbenchKey, contextMenuKey, timelineKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      const contextMenus = context.get(contextMenuKey);
      const timelines = context.get(timelineKey);
      removeContent = context.track(layout.registerContent({
        id: "outline-design.navigation",
        title: "大纲设计",
        role: "navigation",
        order: 10,
        icon: <Icon name="outline"/>,
        render: ({active}) => <OutlineDesignPanel workbench={workbench} contextMenus={contextMenus}
          timelines={timelines} active={active}/>,
      }));
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}
