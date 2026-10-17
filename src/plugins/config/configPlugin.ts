import type {Plugin} from "@lodestory/sdk";
import {configKey} from "@lodestory/sdk/config";
import {pluginsReady} from "../../plugin-core";
import {createConfigStore} from "./configStore";
import applicationConfig from "./config.json";

export const CONFIG_STORAGE_KEY = "lodestory.config-overrides";

/** 独立提供配置数据，不依赖 UI 或让 app 传入业务配置。 */
export function createConfigPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    id: "config", requires: [], provides: [configKey],
    activate(context) {
      let saved: Record<string, unknown> = {};
      try {
        const raw = typeof window === "undefined" ? null : window.localStorage.getItem(CONFIG_STORAGE_KEY);
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Saved configuration must be an object.");
          saved = parsed as Record<string, unknown>;
        }
      } catch (error) { console.warn("Could not load saved configuration; using application defaults.", error); }
      const store = createConfigStore({
        baseValues: applicationConfig,
        userValues: saved,
        persist(values) {
          if (typeof window === "undefined") throw new Error("Configuration persistence is unavailable.");
          window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(values));
        },
      });
      cleanup = store.dispose;
      context.provide(configKey, store.service);
      context.on(pluginsReady, store.seal);
    },
    async deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      await stop?.();
    },
  };
}
