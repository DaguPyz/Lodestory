import type { ServiceKey } from "./ServiceKey";

/** EngineCore 提供给单个插件的能力访问入口；提供能力时会自动记录归属。 */
export type PluginContext = {
  /**
   * 注册本插件提供的能力。激活期间的注册先暂存，activate 成功后才对其他插件可见；
   * 激活成功后的注册立即生效。EngineCore 在卸载时按插件 ID 撤销这些能力。
   * @param key 由能力契约定义并由提供者、使用者共享的标识。
   * @param value 符合该能力契约的实现。
   * @throws 重复提供同一标识或上下文失效时抛错；激活期间与其他插件的冲突在提交时抛错。
   */
  provide<T>(key: ServiceKey<T>, value: T): void;
  /**
   * 获取已注册的能力；激活期间也能获取本插件暂存的能力。
   * @param key 要查找的能力标识。
   * @returns 与该标识关联的能力实现。
   * @throws 能力不存在，或本插件的上下文已失效时抛错。
   */
  get<T>(key: ServiceKey<T>): T;
};

/** 插件只约定生命周期；具体业务能力通过 ServiceKey 另行定义。 */
export type Plugin = {
  /** 插件的唯一标识；EngineCore 用它记录插件及其能力归属。 */
  readonly id: string;
  /**
   * 挂载时由 EngineCore 调用，用于初始化资源和提供能力；可以异步完成。
   * 激活失败时 EngineCore 仍会调用 deactivate，并丢弃此次激活的能力注册。
   * @param context 当前插件专用的能力注册与查询入口。
   */
  activate(context: PluginContext): void | Promise<void>;
  /**
   * 可选的停用回调；卸载或激活失败时由 EngineCore 调用，可异步释放资源。
   * 实现需要能处理只完成了部分初始化的情况；即使清理失败，EngineCore 仍会撤销能力。
   */
  deactivate?(): void | Promise<void>;
};
