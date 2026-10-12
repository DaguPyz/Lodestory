import type { EventKey, EventListener } from "./EventKey.js";
import type { CapabilityKey, ServiceKey } from "./ServiceKey.js";

/** EngineCore 提供给单个插件的能力和事件入口；能力与订阅自动记录归属。 */
export type PluginContext = {
  /**
   * 注册 provides 声明的能力。必须在 activate 结束前完成全部注册；
   * 激活期间先暂存，activate 成功后才对其他插件可见。卸载时按插件 ID 撤销。
   * @param key 由能力契约定义并由提供者、使用者共享的标识。
   * @param value 符合该能力契约的实现。
   * @throws 能力未声明、重复注册或上下文失效时抛错；与其他插件的冲突在提交时抛错。
   */
  provide<T>(key: ServiceKey<T>, value: T): void;
  /**
   * 获取 requires 声明的依赖或本插件的能力；激活期间也能获取本插件暂存的能力。
   * @param key 要查找的能力标识。
   * @returns 与该标识关联的能力实现。
   * @throws 能力未声明、尚未注册或本插件的上下文已失效时抛错。
   */
  get<T>(key: ServiceKey<T>): T;
  /**
   * 订阅共享事件，自动记录当前插件归属，返回可重复调用的取消函数。
   * 激活期间先暂存，能力提交成功后生效；失败或卸载后自动撤销，无须声明能力依赖。
   * @throws 上下文失效时抛错。
   */
  on<T>(key: EventKey<T>, listener: EventListener<T>): () => void;
  /**
   * 按事件 key 通知已生效的监听，按登记顺序逐个等待；无监听时正常完成。
   * 一个监听失败仍继续其他监听，结束后以 EventDispatchError 汇总抛错。
   * 发布者无须提前注册事件；业务自行决定发布位置和怎样处理通知错误。
   * @throws 上下文失效或监听处理失败时拒绝 Promise。
   */
  emit<T>(key: EventKey<T>, payload: T): Promise<void>;
};

/** 插件声明能力关系和生命周期；具体业务接口通过 ServiceKey 另行定义。 */
export type Plugin = {
  /** 插件的唯一标识；EngineCore 用它记录插件、能力和订阅归属。 */
  readonly id: string;
  /** 必需的能力；挂载前须已注册，没有依赖时明确写 []。 */
  readonly requires: readonly CapabilityKey[];
  /** 对外提供的能力；激活结束前须全部注册，没有提供能力时明确写 []。 */
  readonly provides: readonly CapabilityKey[];
  /**
   * 挂载时由 EngineCore 调用，用于初始化资源和提供能力；可以异步完成。
   * 激活失败时 EngineCore 仍会调用 deactivate，并丢弃此次激活的能力注册和订阅。
   * @param context 当前插件专用的能力注册、查询、事件订阅和发布入口。
   */
  activate(context: PluginContext): void | Promise<void>;
  /**
   * 可选的停用回调；卸载或激活失败时由 EngineCore 调用，可异步释放资源。
   * 实现需要能处理只完成了部分初始化的情况；即使清理失败，EngineCore 仍会撤销能力和订阅。
   */
  deactivate?(): void | Promise<void>;
};
