import type { Plugin, ServiceKey } from "@lodestory/sdk";
import { EngineCore, PluginBatchDeactivationError } from "../plugin-core";

/** 一次插件装配的运行实例；具体插件和能力由调用方选择。 */
export type AppRuntime = {
  /** 按共享标识查询插件已提供的能力。 */
  get<T>(key: ServiceKey<T>): T;
  /** 停用单个无依赖者的插件；检查或界面撤回失败时保留该插件。 */
  unmount(id: string): Promise<void>;
  /** 卸载本次启动的插件；并发调用共享结果，准备失败后可重试。 */
  stop(): Promise<void>;
};

/** 创建内核并完成传入插件的初次启动；激活或启动通知失败时清理由内核负责。 */
export async function createAppRuntime(plugins: readonly Plugin[]): Promise<AppRuntime> {
  const core = new EngineCore();
  await core.start(plugins);
  let stopping: Promise<void> | undefined;

  return {
    get<T>(key: ServiceKey<T>): T {
      return core.get(key);
    },
    unmount(id: string) {
      if (stopping) return Promise.reject(new Error("Application stopping or already stopped; plugin removal is unavailable."));
      return core.unmount(id);
    },
    stop() {
      if (!stopping) {
        const attempt = Promise.resolve().then(() => core.unmountAll());
        stopping = attempt;
        void attempt.catch(error => {
          if (!(error instanceof PluginBatchDeactivationError) && stopping === attempt) stopping = undefined;
        });
      }
      return stopping;
    },
  };
}
