import type {Plugin} from "@lodestory/sdk";
import {pluginPackagesKey} from "@lodestory/sdk/plugin-packages";
import {externalPluginsKey} from "@lodestory/sdk/external-plugins";
import {settingsKey} from "@lodestory/sdk/settings";
import {uiKey} from "@lodestory/sdk/ui";
import {i18nKey} from "@lodestory/sdk/i18n";
import {settingsMessages} from "./i18n";
import {PluginSettings} from "./PluginSettings";

/** The management UI is a settings contribution; package storage belongs to its service. */
export function createPluginManagementPlugin(): Plugin {
  let removeSection: (() => void) | undefined;
  let removeMessages: (() => void) | undefined;
  return {
    id: "plugin-management", requires: [settingsKey, pluginPackagesKey, externalPluginsKey, uiKey, i18nKey], provides: [],
    activate(context) {
      const packages = context.get(pluginPackagesKey);
      const plugins = context.get(externalPluginsKey);
      const settings = context.get(settingsKey);
      const ui = context.get(uiKey);
      const i18n = context.get(i18nKey);
      removeMessages = i18n.registerMessages("plugin-management", settingsMessages);
      removeSection = settings.registerSection({
        id: "plugins.packages", group: "应用", title: "插件", order: 40,
        render: () => <PluginSettings packages={packages} plugins={plugins} settings={settings} ui={ui}/>,
      });
    },
    deactivate() {
      try { removeSection?.(); }
      finally {
        removeSection = undefined;
        removeMessages?.();
        removeMessages = undefined;
      }
    },
  };
}
