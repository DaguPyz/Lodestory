import {invoke, isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {backgroundTasksKey, type BackgroundTaskFallback, type BackgroundTasks} from "@lodestory/sdk/background-tasks";

export function createBackgroundTasksPlugin(): Plugin {
  let stop: (() => void) | undefined;
  return {
    id: "background-tasks",
    requires: [],
    provides: [backgroundTasksKey],
    activate(context) {
      let alive = true;
      const fallbacks = new Map<string, BackgroundTaskFallback>();
      const service: BackgroundTasks = {
        registerFallback(name, task) {
          if (!alive || !name || fallbacks.has(name)) throw new Error(`后台任务“${name}”无法登记。`);
          fallbacks.set(name, task);
          return () => { if (fallbacks.get(name) === task) fallbacks.delete(name); };
        },
        async execute(name, input) {
          if (!alive) throw new Error("后台任务服务已停止。");
          let result: Uint8Array;
          if (isTauri()) {
            try {
              const buffer = await invoke<ArrayBuffer>("run_background_task", {name, input});
              if (!(buffer instanceof ArrayBuffer)) throw new Error("后台任务返回了无效数据。");
              result = new Uint8Array(buffer);
            } catch (error) {
              throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "后台任务执行失败。");
            }
          } else {
            const fallback = fallbacks.get(name);
            if (!fallback) throw new Error(`后台任务“${name}”未登记。`);
            result = await fallback(input);
          }
          if (!alive) throw new Error("后台任务服务已停止。");
          return result;
        },
      };
      context.provide(backgroundTasksKey, Object.freeze(service));
      stop = () => { alive = false; fallbacks.clear(); };
    },
    deactivate() { stop?.(); stop = undefined; },
  };
}
