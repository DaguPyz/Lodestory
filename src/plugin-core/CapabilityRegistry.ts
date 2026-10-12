import type { CapabilityKey, ServiceKey } from "@lodestory/sdk";

type Entry = {
  ownerId: string;
  value: unknown;
};

/** EngineCore 在插件激活期间暂存的能力，成功后一次性注册。 */
export type PendingRegistration = {
  key: CapabilityKey;
  value: unknown;
};

/** 保存插件提供的能力；插件对象及其生命周期由 EngineCore 保存和管理。 */
export class CapabilityRegistry {
  private readonly entries = new Map<symbol, Entry>();

  /** 注册一项能力；同一个 key 同时只能有一个提供者。 */
  register<T>(key: ServiceKey<T>, ownerId: string, value: T): void {
    if (this.entries.has(key.token)) {
      throw new Error(`Service '${key.id}' is already registered.`);
    }
    this.entries.set(key.token, { ownerId, value });
  }

  /** 先检查整批能力是否冲突，再统一注册，避免只提交一部分。 */
  registerBatch(ownerId: string, registrations: readonly PendingRegistration[]): void {
    const seen = new Set<symbol>();
    for (const { key } of registrations) {
      if (seen.has(key.token) || this.entries.has(key.token)) {
        throw new Error(`Service '${key.id}' is already registered.`);
      }
      seen.add(key.token);
    }
    for (const { key, value } of registrations) {
      this.entries.set(key.token, { ownerId, value });
    }
  }

  /** 查询能力；缺失时明确报错，不返回一个无法使用的默认值。 */
  get<T>(key: ServiceKey<T>): T {
    const entry = this.entries.get(key.token);
    if (!entry) throw new Error(`Service '${key.id}' is not registered.`);
    return entry.value as T;
  }

  /** 查询能力的提供者，供 Core 检查依赖并保护提供者的生命周期。 */
  getOwnerId(key: CapabilityKey): string | undefined {
    return this.entries.get(key.token)?.ownerId;
  }

  /** 撤销某个插件注册的全部能力。 */
  unregisterOwner(ownerId: string): number {
    let removed = 0;
    for (const [token, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue;
      this.entries.delete(token);
      removed += 1;
    }
    return removed;
  }
}
