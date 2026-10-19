import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {Icon} from "../../components/Icon";
import {OutlineDesignPanel} from "./OutlineDesignPanel";
import "./outline-design.css";

/** 大纲功能独立贡献导航入口与面板，当前不持有大纲数据。 */
export function createOutlineDesignPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "outline-design",
    requires: [layoutKey, workbenchKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      removeContent = layout.registerContent({
        id: "outline-design.navigation",
        title: "大纲设计",
        role: "navigation",
        order: 10,
        icon: <Icon name="outline"/>,
        render: () => <OutlineDesignPanel workbench={workbench}/>,
      });
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}
