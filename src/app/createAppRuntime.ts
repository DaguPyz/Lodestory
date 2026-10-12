import type { Plugin, ServiceKey } from "@lodestory/sdk";
import { EngineCore } from "../plugin-core";

/** 一次插件装配的运行实例；具体插件和能力由调用方选择。 */
export type AppRuntime = {
  /** 按共享标识查询插件已提供的能力。 */
  get<T>(key: ServiceKey<T>): T;
  /** 卸载本次启动的插件；重复调用返回同一个清理 Promise。 */
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
    stop() {
      // 先缓存 Promise 再开始清理，使停用回调中的重复 stop 也共用同一次结果。
      stopping ??= Promise.resolve().then(() => core.unmountAll());
      return stopping;
    },
  };
}
