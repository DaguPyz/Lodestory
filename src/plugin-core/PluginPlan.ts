import type {Plugin, CapabilityKey} from "@lodestory/sdk";

/** 一次挂载使用的固定声明；保留原插件实例调用生命周期方法。 */
export type PluginPlan = {
    readonly id: string;
    readonly plugin: Plugin;
    readonly requires: ReadonlyMap<symbol, CapabilityKey>;
    readonly provides: ReadonlyMap<symbol, CapabilityKey>;
};

export function preparePlugin(plugin: Plugin): PluginPlan {
    const id = plugin.id;
    if (!id.trim()) throw new Error("Plugin id cannot be empty.");
    return {
        id,
        plugin,
        requires: readDeclaration(id, "requires", plugin.requires),
        provides: readDeclaration(id, "provides", plugin.provides),
    };
}

/** 在任何激活前检查整批声明，按能力关系排序；同样可就绪时保持输入顺序。 */
export function sortPlugins(
    plans: readonly PluginPlan[],
    getOwnerId: (key: CapabilityKey) => string | undefined,
): readonly PluginPlan[] {
    const ids = new Set<string>();
    const providers = new Map<symbol, string>();
    for (const plan of plans) {
        if (ids.has(plan.id)) throw new Error(`Plugin '${plan.id}' occurs more than once in the batch.`);
        ids.add(plan.id);
        for (const key of plan.provides.values()) {
            const existingOwner = getOwnerId(key);
            if (existingOwner !== undefined) {
                throw new Error(`Service '${key.id}' declared by plugin '${plan.id}' is already provided by mounted plugin '${existingOwner}'.`);
            }
            const otherProvider = providers.get(key.token);
            if (otherProvider !== undefined) {
                throw new Error(`Service '${key.id}' has multiple providers: plugins '${otherProvider}', '${plan.id}'.`);
            }
            providers.set(key.token, plan.id);
        }
    }

    // 使用者 → 提供者，每个提供者只记一条边；多个能力不会重复增加同一依赖。
    const dependencies = new Map<string, Map<string, CapabilityKey>>();
    const dependents = new Map<string, string[]>();
    for (const plan of plans) {
        const requiredProviders = new Map<string, CapabilityKey>();
        for (const key of plan.requires.values()) {
            if (getOwnerId(key) !== undefined) continue;
            const providerId = providers.get(key.token);
            if (providerId === undefined) {
                throw new Error(`Plugin '${plan.id}' requires service '${key.id}', which has no provider.`);
            }
            if (!requiredProviders.has(providerId)) {
                requiredProviders.set(providerId, key);
                const consumers = dependents.get(providerId) ?? [];
                consumers.push(plan.id);
                dependents.set(providerId, consumers);
            }
        }
        dependencies.set(plan.id, requiredProviders);
    }

    const remaining = new Set(ids);
    const ordered: PluginPlan[] = [];
    while (remaining.size) {
        const next = plans.find(plan => remaining.has(plan.id) && dependencies.get(plan.id)!.size === 0);
        if (!next) throw new Error(describeCycle(dependencies, remaining));
        remaining.delete(next.id);
        ordered.push(next);
        for (const dependentId of dependents.get(next.id) ?? []) {
            dependencies.get(dependentId)!.delete(next.id);
        }
    }
    return ordered;
}

/** 排序停滞后，每个剩余节点都有依赖；沿边找到重复节点，仅报告真正的循环。 */
function describeCycle(dependencies: ReadonlyMap<string, ReadonlyMap<string, CapabilityKey>>, remaining: ReadonlySet<string>): string {
    const positions = new Map<string, number>();
    const path: {consumerId: string; providerId: string; key: CapabilityKey}[] = [];
    let current = remaining.values().next().value!;
    while (!positions.has(current)) {
        positions.set(current, path.length);
        const [providerId, key] = dependencies.get(current)!.entries().next().value!;
        path.push({consumerId: current, providerId, key});
        current = providerId;
    }
    const cycle = path.slice(positions.get(current)!);
    return `Plugin dependency cycle: '${cycle[0].consumerId}'${cycle.map(edge => ` --[${edge.key.id}]--> '${edge.providerId}'`).join("")}.`;
}

/** 后续修改插件对象、能力标识或原数组不能改变本次挂载的能力约束。 */
function readDeclaration(
    pluginId: string,
    field: "requires" | "provides",
    keys: readonly CapabilityKey[],
): ReadonlyMap<symbol, CapabilityKey> {
    if (!Array.isArray(keys)) {
        throw new Error(`Plugin '${pluginId}' must declare '${field}' as an array; use [] when empty.`);
    }
    const declaration = new Map<symbol, CapabilityKey>();
    for (const key of keys) {
        if (declaration.has(key.token)) {
            throw new Error(`Plugin '${pluginId}' declares service '${key.id}' more than once in '${field}'.`);
        }
        declaration.set(key.token, {id: key.id, token: key.token});
    }
    return declaration;
}
