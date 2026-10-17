import {createServiceKey} from "./ServiceKey.js";

/** 配置只保存 JSON 数据；运行时还会拒绝非有限数字、循环引用和非普通对象。 */
export type ConfigValue = null | boolean | number | string | readonly ConfigValue[] | {readonly [key: string]: ConfigValue};

export type ReadonlyConfig<T> = T extends readonly (infer V)[]
  ? readonly ReadonlyConfig<V>[]
  : T extends object ? {readonly [K in keyof T]: ReadonlyConfig<T[K]>} : T;

/** 声明由所属插件导出；其他插件共用同一对象，不重新登记同名项。 */
export type ConfigItem<T extends ConfigValue> = {
  readonly id: string;
  readonly defaultValue: T;
  /** 只描述生效时机；配置服务不操作 UI 或替功能插件应用设置。 */
  readonly effect: "live" | "restart";
  /** 同步校验数据格式与取值范围，业务资源是否存在由功能插件检查。 */
  readonly validate: (value: unknown) => value is T;
};

export type ConfigService = {
  /** 启动期登记；默认值与应用值无效时抛错，失败不留下登记。撤销幂等且保留用户保存值。 */
  register<T extends ConfigValue>(item: ConfigItem<T>): () => void;
  /** 读取不可变有效值，未改变时引用保持稳定；用户值优先于应用配置和声明默认值。 */
  getSnapshot<T extends ConfigValue>(item: ConfigItem<T>): ReadonlyConfig<T>;
  /** 校验并复制输入，按调用顺序保存成功后再发布；校验或保存失败时拒绝且保留原有效值。 */
  set<T extends ConfigValue>(item: ConfigItem<T>, value: T): Promise<void>;
  /** 删除用户覆盖，恢复应用配置或声明默认值；与 set 共用写入顺序。 */
  reset<T extends ConfigValue>(item: ConfigItem<T>): Promise<void>;
  /** 每次订阅独立；单个监听失败不影响其他监听或已完成的保存。 */
  subscribe<T extends ConfigValue>(item: ConfigItem<T>, listener: () => void): () => void;
};

/** 基础配置能力，不依赖 UI、主题或其他功能插件。 */
export const configKey = createServiceKey<ConfigService>("app/config");
