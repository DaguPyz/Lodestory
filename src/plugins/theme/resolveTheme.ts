import type {ResolvedTheme, ThemeColorId, ThemeDefinition, ThemeType} from "@lodestory/sdk/theme";
import {colors as colorRoles, shadowRecipes} from "./color-registry.json";

const roles = new Map(colorRoles.map(entry => [entry.id, entry]));
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isThemeType(value: unknown): value is ThemeType {
    return value === "dark" || value === "light";
}

/** 当前阶段处理已加载的主题数据；主题包来源、安装与 B 检查独立接入。 */
export function resolveThemeDefinition(definition: ThemeDefinition): ResolvedTheme {
    if (!definition || typeof definition !== "object" || definition.schemaVersion !== 1) throw new Error("Invalid theme schema version.");
    if (typeof definition.id !== "string" || definition.id.length > 144 || !idPattern.test(definition.id)) throw new Error("Invalid theme id.");
    if (typeof definition.name !== "string" || !definition.name.trim() || [...definition.name].length > 80 || /[\u0000-\u001f\u007f]/.test(definition.name)) throw new Error("Invalid theme name.");
    if (!isThemeType(definition.type)) throw new Error("Invalid theme type.");
    if (!definition.colors || typeof definition.colors !== "object" || Array.isArray(definition.colors)) throw new Error("Invalid theme colors.");
    for (const key of Object.keys(definition)) if (!["schemaVersion", "id", "name", "type", "colors", "$schema"].includes(key)) throw new Error(`Unknown theme field: ${key}`);
    if (definition.$schema !== undefined && (typeof definition.$schema !== "string" || definition.$schema.length > 256)) throw new Error("Invalid theme schema reference.");
    const supplied = definition.colors as Record<string, unknown>;
    for (const [id, value] of Object.entries(supplied)) {
        const role = roles.get(id);
        if (!role) throw new Error(`Unknown theme color: ${id}`);
        const pattern = role.alphaAllowed ? /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i : /^#[0-9a-f]{6}(?:ff)?$/i;
        if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid theme color: ${id}`);
    }
    const colors: Record<string, string> = {};
    const visiting = new Set<string>();

    function resolve(id: string): string {
        if (Object.prototype.hasOwnProperty.call(colors, id)) return colors[id];
        if (visiting.has(id)) throw new Error(`Circular theme default: ${id}`);
        const role = roles.get(id);
        if (!role) throw new Error(`Unknown theme default: ${id}`);
        visiting.add(id);
        const fallback = role.defaults[definition.type];
        const value = Object.prototype.hasOwnProperty.call(supplied, id) ? supplied[id] as string : typeof fallback === "string" ? fallback : resolve(fallback.ref);
        colors[id] = value;
        visiting.delete(id);
        return value;
    }

    const cssVariables: Record<string, string> = {};
    for (const role of colorRoles) cssVariables[role.cssVariable] = resolve(role.id);
    for (const recipe of shadowRecipes) {
        cssVariables[recipe.cssVariable] = recipe.layers.map(layer => `${layer.x}px ${layer.y}px ${layer.blur}px ${layer.spread}px ${colors[layer.color]}`).join(", ");
    }
    cssVariables["--ui-color-scheme"] = definition.type;
    return Object.freeze({
        id: definition.id,
        name: definition.name,
        type: definition.type,
        colors: Object.freeze(colors) as Record<ThemeColorId, string>,
        cssVariables: Object.freeze(cssVariables)
    });
}
