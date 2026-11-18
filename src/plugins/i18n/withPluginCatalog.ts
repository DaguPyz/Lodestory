import type {Plugin} from "@lodestory/sdk";
import {i18nKey, type MessageCatalog} from "@lodestory/sdk/i18n";

/** Use the plugin's normal activation and cleanup for its application-scoped catalog. */
export function withPluginCatalog(plugin: Plugin, catalog: MessageCatalog | undefined): Plugin {
  if (catalog === undefined) return plugin;
  let removeMessages: (() => void) | undefined;
  return {
    ...plugin,
    requires: plugin.requires.includes(i18nKey) ? plugin.requires : [...plugin.requires, i18nKey],
    activate(context) {
      removeMessages = context.get(i18nKey).registerMessages(plugin.id, catalog);
      return plugin.activate(context);
    },
    async deactivate() {
      const remove = removeMessages;
      removeMessages = undefined;
      if (!remove) return;
      const errors: unknown[] = [];
      try { await plugin.deactivate?.(); } catch (error) { errors.push(error); }
      try { remove(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw Object.assign(new Error(`Plugin '${plugin.id}' and its catalog failed to stop.`), {errors});
    },
  };
}
