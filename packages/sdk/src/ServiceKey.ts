/** 同一项能力的提供者和使用者必须导入同一个 key。 */
declare const serviceType: unique symbol;

/** 声明能力关系时只需要标识，可在同一列表中使用不同接口的 ServiceKey。 */
export type CapabilityKey = Readonly<{
  /** 用于错误信息的能力名称。 */
  id: string;
  /** 容器查找能力时使用的唯一标识。 */
  token: symbol;
}>;

export type ServiceKey<T> = CapabilityKey & Readonly<{
  /** 只供 TypeScript 关联能力接口，不存在于运行时。 */
  [serviceType]?: (value: T) => T;
}>;

/** 为一项能力创建类型化标识；应在能力契约模块中创建一次并共享。 */
export function createServiceKey<T>(id: string): ServiceKey<T> {
  if (!id.trim()) throw new Error("Service key id cannot be empty.");
  return Object.freeze({ id, token: Symbol(id) });
}
