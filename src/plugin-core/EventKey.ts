/** 只供 TypeScript 关联事件的数据类型，不存在于运行时。 */
declare const eventType: unique symbol;

/** 发布者和监听者必须导入同一个事件 key；名称用于说明，token 用于匹配。 */
export type EventKey<T> = Readonly<{
  id: string;
  token: symbol;
  [eventType]?: (payload: T) => T;
}>;

/** 通知监听者；返回值不用于修改或阻止发布者的业务流程。 */
export type EventListener<T> = (payload: T) => void | Promise<void>;

/** 在共享契约模块中创建一次；定义 key 不会向内核注册事件或监听。 */
export function createEventKey<T>(id: string): EventKey<T> {
  if (!id.trim()) throw new Error("Event key id cannot be empty.");
  return Object.freeze({ id, token: Symbol(id) });
}
