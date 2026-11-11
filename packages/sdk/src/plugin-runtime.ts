import {createServiceKey} from "./ServiceKey.js";
import type {Plugin} from "./Plugin.js";

/** Generic host lifecycle operations for plugins discovered after startup. */
export type PluginRuntimeService = {
  mount(plugin: Plugin): Promise<void>;
  unmount(id: string): Promise<void>;
};
export const pluginRuntimeKey = createServiceKey<PluginRuntimeService>("app/plugin-runtime");
