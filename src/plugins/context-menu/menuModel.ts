import type { ReactNode } from "react";
import type { MenuAction, MenuConfig } from "@lodestory/sdk/context-menu";

export type { MenuAction, MenuConfig, MenuEntry } from "@lodestory/sdk/context-menu";

type Condition<T> = boolean | ((context: T) => boolean);

export type ResolvedEntry<T> = MenuAction<T> & { disabled: boolean }
  | { id: string; type: "separator" }
  | { id: string; type: "group"; label?: string; items: ResolvedEntry<T>[] }
  | { id: string; type: "submenu"; label: string; icon?: ReactNode; disabled: boolean; items: ResolvedEntry<T>[] };

function evaluate<T>(condition: Condition<T> | undefined, context: T, fallback: boolean) {
  return typeof condition === "function" ? condition(context) : condition ?? fallback;
}

export function resolveMenu<T>(config: MenuConfig<T>, context: T): ResolvedEntry<T>[] {
  const entries = typeof config === "function" ? config(context) : config;
  const result: ResolvedEntry<T>[] = [];
  for (const entry of entries) {
    if (!evaluate(entry.visible, context, true)) continue;
    if (entry.type === "separator") {
      if (result.length && result[result.length - 1]?.type !== "separator") result.push({ id: entry.id, type: "separator" });
    } else if (entry.type === "group" || entry.type === "submenu") {
      const items = resolveMenu(entry.items, context);
      if (!items.length) continue;
      if (entry.type === "group") result.push({ id: entry.id, type: "group", label: entry.label, items });
      else result.push({ ...entry, items, disabled: evaluate(entry.disabled, context, false) });
    } else {
      result.push({ ...entry, disabled: evaluate(entry.disabled, context, false) });
    }
  }
  if (result[result.length - 1]?.type === "separator") result.pop();
  return result;
}

export function findMenuAction<T>(entries: readonly ResolvedEntry<T>[], path: readonly string[]): (MenuAction<T> & { disabled: boolean }) | undefined {
  const entry = entries.find((item) => item.id === path[0]);
  if (!entry || entry.type === "separator") return undefined;
  if (entry.type === "group" || entry.type === "submenu") {
    if (entry.type === "submenu" && entry.disabled) return undefined;
    return findMenuAction(entry.items, path.slice(1));
  }
  return path.length === 1 ? entry : undefined;
}
