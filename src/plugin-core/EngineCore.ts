import {CapabilityRegistry, type PendingRegistration} from "./CapabilityRegistry";
import type {Plugin, PluginContext, PluginStopParticipant, PluginStopScope, ServiceKey, EventKey, EventListener} from "@lodestory/sdk";
import {preparePlugin, sortPlugins, type PluginPlan} from "./PluginPlan";
import {EventBus} from "./EventBus";
import {pluginsReady} from "./runtimeEvents";

/** 已激活插件的记录，供 EngineCore 在卸载时执行停用和上下文清理。 */
type MountedPlugin = {
  /** 插件实例；卸载时调用它的 deactivate 方法。 */
  plugin: Plugin;
  /** 使上下文失效，阻止卸载后继续操作能力或订阅、发布事件。 */
  revokeContext(): void;
  participants: StopRegistration[];
};

type StopRegistration = {participant: PluginStopParticipant; active: boolean; prepared: PluginStopScope | undefined; withdrawn: boolean};

/**
 * 管理插件从挂载到卸载的过程：检查能力声明和必需依赖后调用 activate；成功后以插件 ID 为键，
 * 把插件对象和上下文撤销方法保存到 mounted Map，供之后卸载使用；
 * 无依赖者时才允许卸载，调用 deactivate、撤销能力和订阅并使插件上下文失效；
 * 激活失败时调用 deactivate 清理已初始化的资源，丢弃暂存能力和订阅。业务能力由插件自行调用。
 */
export class EngineCore {
    /** 保存已注册的能力，供插件和宿主按能力标识查询。 */
    private readonly capabilityRegistry = new CapabilityRegistry();
    /** 保存所有插件的监听与归属，激活成功后生效，失败或卸载后撤销。 */
    private readonly eventBus = new EventBus();
    /** 按激活完成顺序保存插件，供单独卸载或整批逆序卸载时使用。 */
    private readonly mounted = new Map<string, MountedPlugin>();
    /** 标记正在挂载或卸载的插件，避免同一插件的生命周期操作重叠。 */
    private readonly busy = new Set<string>();
    /** 使用者 → 提供者；激活、失败清理和停用期间也保留依赖，防止提供者提前卸载。 */
    private readonly dependencies = new Map<string, ReadonlySet<string>>();
    /** 批量装配、初次启动或停用独占生命周期操作，直到执行或失败清理全部结束。 */
    private batchOperation: "mounting" | "starting" | "unmounting" | undefined;
    /** A single stop also excludes other lifecycle mutations until its UI withdrawal completes. */
    private stopInProgress = false;
    /** 初次启动是一次性操作；失败后同一 Core 也不能再次发送 pluginsReady。 */
    private startAttempted = false;
    /** 普通挂载曾成功后，即使全部卸载，也不再允许把该 Core 当作初始启动实例。 */
    private hasMountedPlugins = false;

    /** 激活插件；失败时停用已初始化部分并撤销它注册的能力和订阅。 */
    async mount(plugin: Plugin): Promise<void> {
        this.checkBatchInactive();
        this.checkPluginAvailable(plugin.id);
        await this.mountPrepared(preparePlugin(plugin));
        this.hasMountedPlugins = true;
    }

    /** 整批预检和排序后逐个激活；失败时仅逆序撤销本批次已挂载的插件。 */
    async mountAll(plugins: readonly Plugin[]): Promise<void> {
        this.checkBatchInactive();
        if (this.stopInProgress && !this.busy.size) throw new Error("Cannot mount plugin batch while a plugin is changing state.");
        this.batchOperation = "mounting";
        try {
            await this.mountBatch(plugins);
        } finally {
            this.batchOperation = undefined;
        }
    }

    /**
     * 在全新 Core 上只执行一次初次启动：整批插件激活成功后通知 pluginsReady。
     * 激活失败沿用 mountAll 的回滚语义；通知失败则逆序卸载本次插件，清理也失败时抛 StartupError。
     */
    async start(plugins: readonly Plugin[]): Promise<void> {
        this.checkBatchInactive();
        if (this.startAttempted) throw new Error("EngineCore.start can only be called once.");
        if (this.hasMountedPlugins || this.mounted.size || this.busy.size) {
            throw new Error("EngineCore.start is only available on a new core with no prior, mounted, or changing plugins.");
        }

        this.startAttempted = true;
        this.batchOperation = "starting";
        try {
            const mountedIds = await this.mountBatch(plugins);
            try {
                await this.eventBus.emit(pluginsReady, undefined);
            } catch (startupError) {
                const cleanupErrors = await this.unmountBatch(mountedIds);
                if (cleanupErrors.length) {
                    throw new StartupError(startupError, new PluginBatchDeactivationError(cleanupErrors));
                }
                throw startupError;
            }
        } finally {
            this.batchOperation = undefined;
        }
    }

    /** 执行已经由调用者加锁的批量挂载；失败时只回滚本批次成功挂载的插件。 */
    private async mountBatch(plugins: readonly Plugin[]): Promise<string[]> {
        if (this.busy.size) {
            throw new Error(`Cannot mount plugin batch while plugins are changing state: ${[...this.busy].map(id => `'${id}'`).join(", ")}.`);
        }

        const plans = plugins.map(preparePlugin);
        for (const plan of plans) this.checkPluginAvailable(plan.id);
        const ordered = sortPlugins(plans, key => this.capabilityRegistry.getOwnerId(key));
        const mountedIds: string[] = [];
        for (const plan of ordered) {
            try {
                await this.mountPrepared(plan);
                mountedIds.push(plan.id);
                this.hasMountedPlugins = true;
            } catch (activationError) {
                const rollbackErrors = await this.unmountBatch(mountedIds);
                if (rollbackErrors.length) {
                    throw new PluginBatchActivationError(plan.id, activationError, rollbackErrors);
                }
                throw activationError;
            }
        }
        return mountedIds;
    }

    /** 按本批次激活顺序逆序清理，并在失败时继续处理其余插件。 */
    private async unmountBatch(mountedIds: readonly string[]): Promise<{pluginId: string; error: unknown}[]> {
        const cleanupErrors: {pluginId: string; error: unknown}[] = [];
        for (const id of [...mountedIds].reverse()) {
            try {
                await this.unmountPlugin(id);
            } catch (error) {
                cleanupErrors.push({pluginId: id, error});
            }
        }
        return cleanupErrors;
    }

    private checkBatchInactive(): void {
        if (this.batchOperation) throw new Error(`Plugin batch ${this.batchOperation} is in progress; other lifecycle operations are unavailable.`);
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

        if (this.stopInProgress) throw new Error("Cannot mount a plugin while another plugin is being unmounted.");

        this.busy.add(id);
        this.dependencies.set(id, owners);
        let contextActive = true;
        let activated = false;
        const stopOwner = Symbol(id);
        const participants: StopRegistration[] = [];
        const pending = new Map<symbol, PendingRegistration>();
        const checkContext = () => {
            if (!contextActive) throw new Error(`Plugin '${id}' context is no longer active.`);
        };
        const registerStop = (participant: PluginStopParticipant) => {
            checkContext();
            if (activated) throw new Error(`Plugin '${id}' must register stop participants during activation.`);
            if (!participant || (typeof participant !== "object" && typeof participant !== "function")
                || (participant.check !== undefined && typeof participant.check !== "function")
                || (participant.prepare !== undefined && typeof participant.prepare !== "function")
                || (participant.cancel !== undefined && typeof participant.cancel !== "function")
                || (participant.withdrawOrder !== undefined && typeof participant.withdrawOrder !== "function"
                    && !Number.isFinite(participant.withdrawOrder))
                || (participant.withdraw !== undefined && typeof participant.withdraw !== "function")) {
                throw new TypeError("Invalid plugin stop participant.");
            }
            const snapshot: PluginStopParticipant = Object.freeze({
                ...(participant.withdrawOrder === undefined ? {} : {withdrawOrder: typeof participant.withdrawOrder === "function"
                    ? participant.withdrawOrder.bind(participant) : participant.withdrawOrder}),
                ...(participant.check ? {check: participant.check.bind(participant)} : {}),
                ...(participant.prepare ? {prepare: participant.prepare.bind(participant)} : {}),
                ...(participant.cancel ? {cancel: participant.cancel.bind(participant)} : {}),
                ...(participant.withdraw ? {withdraw: participant.withdraw.bind(participant)} : {}),
            });
            const registration: StopRegistration = {participant: snapshot, active: true, prepared: undefined, withdrawn: false};
            participants.push(registration);
            return () => { registration.active = false; };
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
            on: <T>(key: EventKey<T>, listener: EventListener<T>) => {
                checkContext();
                return this.eventBus.on(key, id, listener, !activated);
            },
            emit: async <T>(key: EventKey<T>, payload: T) => {
                checkContext();
                if (key.token === pluginsReady.token) {
                    throw new Error("The pluginsReady event is reserved for EngineCore.start.");
                }
                await this.eventBus.emit(key, payload);
            },
            onStop: registerStop,
            track: participant => {
                if (typeof participant.associate !== "function" || typeof participant.check !== "function" || typeof participant.withdraw !== "function") {
                    try { participant(); } catch (error) {
                        throw Object.assign(new Error("Invalid tracked contribution could not be cleaned up."), {cause: error});
                    }
                    throw new TypeError("Tracked contributions must support stop checks and withdrawal.");
                }
                participant.associate(stopOwner);
                try {
                    registerStop(participant);
                } catch (error) {
                    try { participant(); } catch (cleanupError) {
                        throw Object.assign(new Error("Contribution tracking and cleanup both failed."), {cause: error, cleanupError});
                    }
                    throw error;
                }
                return participant;
            },
        };

        try {
            await plugin.activate(context);
            const missing = [...provides.values()].filter(key => !pending.has(key.token));
            if (missing.length) {
                throw new Error(`Plugin '${id}' did not provide declared services: ${missing.map(key => `'${key.id}'`).join(", ")}.`);
            }
            this.capabilityRegistry.registerBatch(id, [...pending.values()]);
            this.eventBus.commitOwner(id);
            pending.clear();
            activated = true;
            this.mounted.set(id, {
                plugin, participants, revokeContext: () => {
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
                this.eventBus.unregisterOwner(id);
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

    /** 停用插件；即使停用逻辑失败，也会撤销能力和订阅并使旧 context 失效。 */
    async unmount(id: string): Promise<void> {
        this.checkBatchInactive();
        if (this.busy.size) {
            if (this.busy.has(id)) throw new Error(`Plugin '${id}' is changing state.`);
            const dependents = [...this.dependencies].filter(([, owners]) => owners.has(id)).map(([dependent]) => `'${dependent}'`);
            if (dependents.length) throw new Error(`Plugin '${id}' cannot be unmounted; required by plugins: ${dependents.join(", ")}.`);
            throw new Error(`Cannot unmount plugin while plugins are changing state: ${[...this.busy].map(changing => `'${changing}'`).join(", ")}.`);
        }
        if (this.stopInProgress) throw new Error("Cannot unmount plugin while another plugin is changing state.");
        this.stopInProgress = true;
        try {
            await this.unmountPlugin(id, true);
        } finally {
            this.stopInProgress = false;
        }
    }

    /** 按实际激活顺序逆序停用所有插件；清理失败仍继续，最后汇总错误。 */
    async unmountAll(): Promise<void> {
        this.checkBatchInactive();
        if (this.stopInProgress && !this.busy.size) throw new Error("Cannot unmount plugin batch while a plugin is changing state.");
        if (this.busy.size) {
            throw new Error(`Cannot unmount plugin batch while plugins are changing state: ${[...this.busy].map(id => `'${id}'`).join(", ")}.`);
        }

        this.batchOperation = "unmounting";
        try {
            const entries = [...this.mounted.entries()].reverse();
            try {
                await this.checkStop(entries, "application");
                await this.prepareStop(entries, "application");
                await this.withdrawStop(entries, "application");
            } catch (error) {
                await this.resetStopPreparation(entries, "application", error);
                throw error;
            }
            // 提供者先激活、使用者后激活，因此先停用使用者，才能安全停用提供者。
            const cleanupErrors = await this.unmountBatch([...this.mounted.keys()]);
            if (cleanupErrors.length) throw new PluginBatchDeactivationError(cleanupErrors);
        } finally {
            this.batchOperation = undefined;
        }
    }

    private async unmountPlugin(id: string, prepareStop = false): Promise<void> {
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
            if (prepareStop) {
                await this.checkStop([[id, entry]], "plugin");
                await this.prepareStop([[id, entry]], "plugin");
                await this.withdrawStop([[id, entry]], "plugin");
            }
        } catch (error) {
            await this.resetStopPreparation([[id, entry]], "plugin", error);
            this.busy.delete(id);
            throw error;
        }
        try {
            await entry.plugin.deactivate?.();
        } finally {
            entry.revokeContext();
            this.capabilityRegistry.unregisterOwner(id);
            this.eventBus.unregisterOwner(id);
            this.mounted.delete(id);
            this.dependencies.delete(id);
            this.busy.delete(id);
        }
    }

    private async checkStop(entries: readonly [string, MountedPlugin][], scope: PluginStopScope): Promise<void> {
        for (const [id, entry] of entries) {
            for (const registration of [...entry.participants].reverse()) {
                if (!registration.active || registration.withdrawn) continue;
                try { await registration.participant.check?.(scope); }
                catch (error) { throw new PluginStopPreparationError(id, "check", error); }
            }
        }
    }

    private async withdrawStop(entries: readonly [string, MountedPlugin][], scope: PluginStopScope): Promise<void> {
        const ordered = entries.flatMap(([id, entry]) => [...entry.participants].reverse()
            .filter(registration => registration.active && !registration.withdrawn).map(registration => {
            try {
                const source = registration.participant.withdrawOrder;
                const order = typeof source === "function" ? source(scope) : (source ?? 0);
                if (!Number.isFinite(order)) throw new TypeError("Stop withdrawal order must be finite.");
                return {id, registration, order};
            } catch (error) { throw new PluginStopPreparationError(id, "withdraw", error); }
            }));
        ordered.sort((a, b) => a.order - b.order);
        for (const {id, registration} of ordered) {
            if (!registration.active || registration.withdrawn) continue;
            try {
                await registration.participant.withdraw?.(scope);
                registration.withdrawn = true;
            } catch (error) {
                throw new PluginStopPreparationError(id, "withdraw", error);
            }
        }
    }

    private async prepareStop(entries: readonly [string, MountedPlugin][], scope: PluginStopScope): Promise<void> {
        for (const [id, entry] of entries) {
            for (const registration of [...entry.participants].reverse()) {
                if (!registration.active || registration.prepared === scope || registration.withdrawn) continue;
                try {
                    await registration.participant.prepare?.(scope);
                    registration.prepared = scope;
                } catch (error) { throw new PluginStopPreparationError(id, "prepare", error); }
            }
        }
    }

    private async resetStopPreparation(entries: readonly [string, MountedPlugin][], scope: PluginStopScope, originalError: unknown): Promise<void> {
        const errors: unknown[] = [];
        for (const [, entry] of [...entries].reverse()) {
            for (const registration of entry.participants) {
                if (registration.withdrawn || registration.prepared !== scope) continue;
                try { await registration.participant.cancel?.(scope); } catch (error) { errors.push(error); }
                registration.prepared = undefined;
            }
        }
        if (errors.length && originalError instanceof Error) Object.assign(originalError, {cancellationErrors: errors});
    }

    /** 供宿主调用插件公开的能力；业务插件仍通过自己的 context 查询。 */
    get<T>(key: ServiceKey<T>): T {
        return this.capabilityRegistry.get(key);
    }

    isMounted(id: string): boolean {
        return this.mounted.has(id);
    }
}

/** 停止准备失败时插件及其能力仍然可用；完成的撤回不会在重试时重复执行。 */
export class PluginStopPreparationError extends Error {
    constructor(readonly pluginId: string, readonly phase: "check" | "prepare" | "withdraw", readonly cause: unknown) {
        super(`Plugin '${pluginId}' stop ${phase} failed.`);
        this.name = "PluginStopPreparationError";
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

/** 整批停用已完成，保留每个插件的清理错误。 */
export class PluginBatchDeactivationError extends Error {
    constructor(
        readonly cleanupErrors: readonly {readonly pluginId: string; readonly error: unknown}[],
    ) {
        super(`Plugin batch cleanup failed for plugins: ${cleanupErrors.map(entry => `'${entry.pluginId}'`).join(", ")}.`);
        this.name = "PluginBatchDeactivationError";
    }
}

/** 初次启动通知失败且逆序清理也失败时，同时保留两类错误。 */
export class StartupError extends Error {
    constructor(
        readonly startupError: unknown,
        readonly cleanupError: PluginBatchDeactivationError,
    ) {
        super("EngineCore startup notification failed and plugin cleanup also failed.");
        this.name = "StartupError";
    }
}
