import {CapabilityRegistry, type PendingRegistration} from "./CapabilityRegistry";
import type {Plugin, PluginContext} from "./Plugin";
import type {ServiceKey} from "./ServiceKey";

/** 已激活插件的记录，供 EngineCore 在卸载时执行停用和上下文清理。 */
type MountedPlugin = {
  /** 插件实例；卸载时调用它的 deactivate 方法。 */
  plugin: Plugin;
  /** 使该插件持有的上下文失效，阻止卸载后继续注册或查询能力。 */
  revokeContext(): void;
};

/**
 * 管理插件从挂载到卸载的过程：挂载时调用 activate；成功后以插件 ID 为键，
 * 把插件对象和上下文撤销方法保存到 mounted Map，供之后卸载使用；
 * 卸载时调用 deactivate、撤销能力并使插件上下文失效；
 * 激活失败时调用 deactivate 清理已初始化的资源。业务能力由插件自行调用。
 */
export class EngineCore {
    /** 保存已注册的能力，供插件和宿主按能力标识查询。 */
    private readonly capabilityRegistry = new CapabilityRegistry();
    /** 保存已成功激活的插件及其上下文撤销方法，供卸载时使用。 */
    private readonly mounted = new Map<string, MountedPlugin>();
    /** 标记正在挂载或卸载的插件，避免同一插件的生命周期操作重叠。 */
    private readonly busy = new Set<string>();

    /** 激活插件；失败时停用已初始化部分并撤销它注册的能力。 */
    async mount(plugin: Plugin): Promise<void> {
        const id = plugin.id;
        if (!id.trim()) throw new Error("Plugin id cannot be empty.");
        if (this.mounted.has(id) || this.busy.has(id)) {
            throw new Error(`Plugin '${id}' is already mounted or changing state.`);
        }

        this.busy.add(id);
        let contextActive = true;
        let activated = false;
        const pending = new Map<symbol, PendingRegistration>();
        const checkContext = () => {
            if (!contextActive) throw new Error(`Plugin '${id}' context is no longer active.`);
        };
        const context: PluginContext = {
            provide: <T>(key: ServiceKey<T>, value: T) => {
                checkContext();
                if (activated) {
                    this.capabilityRegistry.register(key, id, value);
                } else {
                    if (pending.has(key.token)) throw new Error(`Service '${key.id}' is already registered.`);
                    pending.set(key.token, {key, value});
                }
            },
            get: <T>(key: ServiceKey<T>): T => {
                checkContext();
                const own = pending.get(key.token);
                if (own) return own.value as T;
                return this.capabilityRegistry.get(key);
            },
        };

        try {
            await plugin.activate(context);
            this.capabilityRegistry.registerBatch(id, [...pending.values()]);
            pending.clear();
            activated = true;
            this.mounted.set(id, {
                plugin, revokeContext: () => {
                    contextActive = false;
                }
            });
        } catch (activationError) {
            let cleanupError: unknown;
            let cleanupFailed = false;
            try {
                await plugin.deactivate?.();
            } catch (error) {
                cleanupError = error;
                cleanupFailed = true;
            } finally {
                contextActive = false;
                this.capabilityRegistry.unregisterOwner(id);
            }
            if (cleanupFailed) {
                throw new PluginActivationError(id, activationError, cleanupError);
            }
            throw activationError;
        } finally {
            this.busy.delete(id);
        }
    }

    /** 停用插件；即使停用逻辑失败，也会撤销能力并使旧 context 失效。 */
    async unmount(id: string): Promise<void> {
        if (this.busy.has(id)) throw new Error(`Plugin '${id}' is changing state.`);
        const entry = this.mounted.get(id);
        if (!entry) throw new Error(`Plugin '${id}' is not mounted.`);

        this.busy.add(id);
        try {
            await entry.plugin.deactivate?.();
        } finally {
            entry.revokeContext();
            this.capabilityRegistry.unregisterOwner(id);
            this.mounted.delete(id);
            this.busy.delete(id);
        }
    }

    /** 供宿主调用插件公开的能力；业务插件仍通过自己的 context 查询。 */
    get<T>(key: ServiceKey<T>): T {
        return this.capabilityRegistry.get(key);
    }

    isMounted(id: string): boolean {
        return this.mounted.has(id);
    }
}

/** 同时保留激活错误和停用错误，避免清理失败掩盖原始原因。 */
export class PluginActivationError extends Error {
    constructor(
        readonly pluginId: string,
        readonly activationError: unknown,
        readonly cleanupError: unknown,
    ) {
        super(`Plugin '${pluginId}' failed to activate and clean up.`);
        this.name = "PluginActivationError";
    }
}
