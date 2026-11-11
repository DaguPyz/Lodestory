import type {Plugin} from "@lodestory/sdk";
import {pluginPackagesKey} from "@lodestory/sdk/plugin-packages";
import {settingsKey} from "@lodestory/sdk/settings";
import {PluginSettings} from "./PluginSettings";

/** The management UI is a settings contribution; package storage belongs to its service. */
export function createPluginManagementPlugin(): Plugin {
  let removeSection: (() => void) | undefined;
  return {
    id: "plugin-management", requires: [settingsKey, pluginPackagesKey], provides: [],
    activate(context) {
      const packages = context.get(pluginPackagesKey);
      removeSection = context.get(settingsKey).registerSection({
        id: "plugins.packages", group: "应用", title: "插件", order: 40,
        render: () => <PluginSettings packages={packages}/>,
      });
    },
    deactivate() {const remove = removeSection; removeSection = undefined; remove?.();},
  };
}
