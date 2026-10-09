import type { EventKey, EventListener } from "./EventKey";

type Subscription = {
  ownerId: string;
  listener: EventListener<unknown>;
  /** 激活成功后才参与发布时的监听快照。 */
  committed: boolean;
  /** 已进入快照但尚未执行的监听，也能被取消。 */
  active: boolean;
};

/** Core 持有的事件订阅表；首次订阅时建表，不要求发布者提前登记。 */
export class EventBus {
  private readonly subscriptions = new Map<symbol, Subscription[]>();

  /** 登记监听并记录归属；Core 激活插件时以 pending=true 暂存订阅。 */
  on<T>(key: EventKey<T>, ownerId: string, listener: EventListener<T>, pending = false): () => void {
    const token = key.token;
    const subscription: Subscription = {
      ownerId,
      listener: payload => listener(payload as T),
      committed: !pending,
      active: true,
    };
    const listeners = this.subscriptions.get(token) ?? [];
    listeners.push(subscription);
    this.subscriptions.set(token, listeners);

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      const current = this.subscriptions.get(token);
      if (!current) return;
      const index = current.indexOf(subscription);
      if (index !== -1) current.splice(index, 1);
      if (!current.length) this.subscriptions.delete(token);
    };
  }

  /** 插件激活和能力检查成功后，公开它仍未取消的订阅；不会调用监听。 */
  commitOwner(ownerId: string): void {
    for (const listeners of this.subscriptions.values()) {
      for (const subscription of listeners) {
        if (subscription.ownerId === ownerId) subscription.committed = true;
      }
    }
  }

  /** 发布时复制已生效的列表，逐个等待；没有监听时正常完成。 */
  async emit<T>(key: EventKey<T>, payload: T): Promise<void> {
    const listeners = (this.subscriptions.get(key.token) ?? [])
      .filter(subscription => subscription.committed);
    const listenerErrors: { pluginId: string; error: unknown }[] = [];
    for (const subscription of listeners) {
      if (!subscription.active) continue;
      try {
        await subscription.listener(payload);
      } catch (error) {
        listenerErrors.push({ pluginId: subscription.ownerId, error });
      }
    }
    if (listenerErrors.length) throw new EventDispatchError(key.id, listenerErrors);
  }

  /** 取消所属插件的全部订阅；已开始的回调继续，尚未开始的回调跳过。 */
  unregisterOwner(ownerId: string): void {
    for (const [token, listeners] of this.subscriptions) {
      const remaining: Subscription[] = [];
      for (const subscription of listeners) {
        if (subscription.ownerId === ownerId) subscription.active = false;
        else remaining.push(subscription);
      }
      if (remaining.length) this.subscriptions.set(token, remaining);
      else this.subscriptions.delete(token);
    }
  }
}

/** 保留本次通知中每个失败监听的插件归属和原始错误。 */
export class EventDispatchError extends Error {
  constructor(
    readonly eventId: string,
    readonly listenerErrors: readonly { pluginId: string; error: unknown }[],
  ) {
    super(`Event '${eventId}' failed in ${listenerErrors.length} listener(s).`);
    this.name = "EventDispatchError";
  }
}
