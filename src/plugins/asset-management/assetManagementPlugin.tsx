import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {Icon} from "@lodestory/ui";
import "./asset-management.css";

/** Owns the asset-management entry; object data and template editing are not implemented yet. */
export function createAssetManagementPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "asset-management",
    requires: [layoutKey],
    provides: [],
    activate(context) {
      removeContent = context.get(layoutKey).registerContent({
        id: "asset-management.navigation",
        title: "资产管理",
        role: "navigation",
        order: 20,
        icon: <Icon name="assets"/>,
        render: () => <div className="asset-management-panel"><p>暂无资产。</p></div>,
      });
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}
