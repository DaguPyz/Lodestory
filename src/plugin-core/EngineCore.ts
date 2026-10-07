import {CapabilityRegistry, type PendingRegistration} from "./CapabilityRegistry";
import type {Plugin, PluginContext} from "./Plugin";
import {preparePlugin, sortPlugins, type PluginPlan} from "./PluginPlan";
import type {ServiceKey} from "./ServiceKey";

/** 已激活插件的记录，供 EngineCore 在卸载时执行停用和上下文清理。 */
type MountedPlugin = {
  /** 插件实例；卸载时调用它的 deactivate 方法。 */
  plugin: Plugin;
  /** 使该插件持有的上下文失效，阻止卸载后继续注册或查询能力。 */
  revokeContext(): void;
};

/**
 * 管理插件从挂载到卸载的过程：检查能力声明和必需依赖后调用 activate；成功后以插件 ID 为键，
 * 把插件对象和上下文撤销方法保存到 mounted Map，供之后卸载使用；
 * 无依赖者时才允许卸载，调用 deactivate、撤销能力并使插件上下文失效；
 * 激活失败时调用 deactivate 清理已初始化的资源。业务能力由插件自行调用。
 */
export class EngineCore {
    /** 保存已注册的能力，供插件和宿主按能力标识查询。 */
    private readonly capabilityRegistry = new CapabilityRegistry();
    /** 保存已成功激活的插件及其上下文撤销方法，供卸载时使用。 */
    private readonly mounted = new Map<string, MountedPlugin>();
    /** 标记正在挂载或卸载的插件，避免同一插件的生命周期操作重叠。 */
    private readonly busy = new Set<string>();
    /** 使用者 → 提供者；激活、失败清理和停用期间也保留依赖，防止提供者提前卸载。 */
    private readonly dependencies = new Map<string, ReadonlySet<string>>();
    /** 批量装配独占生命周期操作，直到激活或回滚全部结束。 */
    private batchActive = false;

    /** 激活插件；失败时停用已初始化部分并撤销它注册的能力。 */
    async mount(plugin: Plugin): Promise<void> {
        this.checkBatchInactive();
        this.checkPluginAvailable(plugin.id);
        await this.mountPrepared(preparePlugin(plugin));
    }

    /** 整批预检和排序后逐个激活；失败时仅逆序撤销本批次已挂载的插件。 */
    async mountAll(plugins: readonly Plugin[]): Promise<void> {
        this.checkBatchInactive();
        if (this.busy.size) {
            throw new Error(`Cannot mount plugin batch while plugins are changing state: ${[...this.busy].map(id => `'${id}'`).join(", ")}.`);
        }

        this.batchActive = true;
        try {
            const plans = plugins.map(preparePlugin);
            for (const plan of plans) this.checkPluginAvailable(plan.id);
            const ordered = sortPlugins(plans, key => this.capabilityRegistry.getOwnerId(key));
            const mountedIds: string[] = [];
            for (const plan of ordered) {
                try {
                    await this.mountPrepared(plan);
                    mountedIds.push(plan.id);
                } catch (activationError) {
                    const rollbackErrors: {pluginId: string; error: unknown}[] = [];
                    for (const id of mountedIds.reverse()) {
                        try {
                            await this.unmountPlugin(id);
                        } catch (error) {
                            rollbackErrors.push({pluginId: id, error});
                        }
                    }
                    if (rollbackErrors.length) {
                        throw new PluginBatchActivationError(plan.id, activationError, rollbackErrors);
                    }
                    throw activationError;
                }
            }
        } finally {
            this.batchActive = false;
        }
    }

    private checkBatchInactive(): void {
        if (this.batchActive) throw new Error("Plugin batch mounting is in progress; other lifecycle operations are unavailable.");
    }

    private checkPluginAvailable(id: string): void {
        if (!id.trim()) throw new Error("Plugin id cannot be empty.");
        if (this.mounted.has(id) || this.busy.has(id)) {
            throw new Error(`Plugin '${id}' is already mounted or changing state.`);
        }
    }

    private async mountPrepared({id, plugin, requires, provides}: PluginPlan): Promise<void> {
        const owners = new Set<string>();
        for (const key of requires.values()) {
            const ownerId = this.capabilityRegistry.getOwnerId(key);
            if (ownerId === undefined) {
                throw new Error(`Plugin '${id}' requires service '${key.id}', which is not registered.`);
            }
            if (this.busy.has(ownerId)) {
                throw new Error(`Plugin '${id}' requires service '${key.id}' from plugin '${ownerId}', which is changing state.`);
            }
            owners.add(ownerId);
        }

        this.busy.add(id);
        this.dependencies.set(id, owners);
        let contextActive = true;
        let activated = false;
        const pending = new Map<symbol, PendingRegistration>();
        const checkContext = () => {
            if (!contextActive) throw new Error(`Plugin '${id}' context is no longer active.`);
        };
        const context: PluginContext = {
            provide: <T>(key: ServiceKey<T>, value: T) => {
                checkContext();
                const declared = provides.get(key.token);
                if (!declared) {
                    throw new Error(`Plugin '${id}' cannot provide undeclared service '${key.id}'.`);
                }
                if (activated) {
                    this.capabilityRegistry.register(key, id, value);
                } else {
                    if (pending.has(key.token)) throw new Error(`Service '${key.id}' is already registered.`);
                    pending.set(key.token, {key: declared, value});
                }
            },
            get: <T>(key: ServiceKey<T>): T => {
                checkContext();
                if (!requires.has(key.token) && !provides.has(key.token)) {
                    throw new Error(`Plugin '${id}' cannot get undeclared service '${key.id}'.`);
                }
                const own = pending.get(key.token);
                if (own) return own.value as T;
                if (!activated && !requires.has(key.token)) {
                    throw new Error(`Service '${key.id}' is not registered by plugin '${id}'.`);
                }
                return this.capabilityRegistry.get(key);
            },
        };

        try {
            await plugin.activate(context);
            const missing = [...provides.values()].filter(key => !pending.has(key.token));
            if (missing.length) {
                throw new Error(`Plugin '${id}' did not provide declared services: ${missing.map(key => `'${key.id}'`).join(", ")}.`);
            }
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
                pending.clear();
                this.capabilityRegistry.unregisterOwner(id);
                this.dependencies.delete(id);
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
        this.checkBatchInactive();
        await this.unmountPlugin(id);
    }

    private async unmountPlugin(id: string): Promise<void> {
        if (this.busy.has(id)) throw new Error(`Plugin '${id}' is changing state.`);
        const entry = this.mounted.get(id);
        if (!entry) throw new Error(`Plugin '${id}' is not mounted.`);

        const dependents = [...this.dependencies]
            .filter(([, owners]) => owners.has(id))
            .map(([dependentId]) => `'${dependentId}'`);
        if (dependents.length) {
            throw new Error(`Plugin '${id}' cannot be unmounted; required by plugins: ${dependents.join(", ")}.`);
        }

        this.busy.add(id);
        try {
            await entry.plugin.deactivate?.();
        } finally {
            entry.revokeContext();
            this.capabilityRegistry.unregisterOwner(id);
            this.mounted.delete(id);
            this.dependencies.delete(id);
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

/** 回滚继续处理整批插件，错误同时保留原始激活失败和每个停用失败。 */
export class PluginBatchActivationError extends Error {
    constructor(
        readonly pluginId: string,
        readonly activationError: unknown,
        readonly rollbackErrors: readonly {readonly pluginId: string; readonly error: unknown}[],
    ) {
        super(`Plugin '${pluginId}' failed to activate and batch rollback failed for plugins: ${rollbackErrors.map(entry => `'${entry.pluginId}'`).join(", ")}.`);
        this.name = "PluginBatchActivationError";
    }
}
