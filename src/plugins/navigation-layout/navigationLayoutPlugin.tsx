import type {Plugin} from "@lodestory/sdk";
import {flushSync} from "react-dom";
import {navigationLayoutKey, type NavigationLayoutService} from "@lodestory/sdk/navigation-layout";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {windowShellKey} from "@lodestory/sdk/window-shell";
import {NavigationLayout, type RegisteredNavigationItem} from "./NavigationLayout";

/** 拥有应用导航布局；页面内容由各插件登记，页面状态和切换仍交给 UI。 */
export function createNavigationLayoutPlugin(): Plugin {
    let cleanup: (() => void) | undefined;

    return {
        id: "navigation-layout",
        requires: [uiKey, themeKey, windowShellKey],
        provides: [navigationLayoutKey],
        activate(context) {
            const ui = context.get(uiKey);
            const WindowShell = context.get(windowShellKey).View;
            const entries = new Map<string, { item: RegisteredNavigationItem; run?: () => void | Promise<void>; remove: () => void }>();
            const listeners = new Set<() => void>();
            let snapshot: readonly RegisteredNavigationItem[] = Object.freeze([]);
            let active = true;

            const items = () => [...entries.values()].map(entry => entry.item).sort((a, b) =>
                (a.group === b.group ? 0 : a.group === "primary" ? -1 : 1)
                || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const publish = () => {
                snapshot = Object.freeze(items());
                for (const listener of [...listeners]) {
                    try { listener(); } catch (error) { console.error("Navigation subscriber failed.", {error}); }
                }
            };
            const subscribe = (listener: () => void) => {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            };

            cleanup = () => {
                // UI 撤销会先卸载组件；条目及页面资源保留到撤销完成。
                const errors: unknown[] = [];
                for (const entry of [...entries.values()].reverse()) {
                    try { entry.remove(); } catch (error) { errors.push(error); }
                }
                active = false;
                listeners.clear();
                if (errors.length) throw Object.assign(new Error("Navigation layout failed to stop."), {errors});
            };

            const service: NavigationLayoutService = {
                registerPage(page) {
                    if (!active) throw new Error("Navigation layout service is no longer active.");
                    const {id, render} = page;
                    const item = Object.freeze({
                        id,
                        kind: "page" as const,
                        label: page.navigation.label,
                        icon: page.navigation.icon,
                        group: page.navigation.group ?? "primary",
                        order: page.navigation.order ?? 0,
                    });
                    if (typeof id !== "string" || !id.trim()) throw new Error("Navigation page id cannot be empty.");
                    if (typeof item.label !== "string" || !item.label.trim()) throw new Error("Navigation label cannot be empty.");
                    if (item.group !== "primary" && item.group !== "secondary") throw new Error("Unknown navigation group.");
                    if (!Number.isFinite(item.order)) throw new Error("Navigation order must be finite.");
                    if (typeof render !== "function") throw new Error("Navigation page must have a render function.");
                    if (entries.has(id)) throw new Error(`Navigation page '${id}' is already registered.`);

                    // UI 拒绝迟到或冲突的登记时，导航目录也不发生变化。
                    const removePage = ui.registerPage({
                        id,
                        render: pageContext => <WindowShell><NavigationLayout
                            pageId={id}
                            active={pageContext.active}
                            items={items()}
                            subscribeItems={subscribe}
                            getItems={() => snapshot}
                            onNavigate={async target => {
                                const entry = entries.get(target);
                                if (!entry) return false;
                                if (entry.item.kind === "page") return ui.openPage(target);
                                await entry.run?.();
                                return true;
                            }}
                        >{render(pageContext)}</NavigationLayout></WindowShell>,
                    });
                    const entry = {
                        item,
                        remove() {
                            if (entries.get(id) !== entry) return;
                            removePage();
                            entries.delete(id);
                            publish();
                        },
                    };
                    entries.set(id, entry);
                    publish();
                    return Object.assign(entry.remove, {
                        associate: (owner: symbol) => removePage.associate(owner),
                        withdrawOrder: (scope: "plugin" | "application") => {
                            const order = removePage.withdrawOrder;
                            return typeof order === "function" ? order(scope) : (order ?? 0);
                        },
                        check: (scope: "plugin" | "application") => removePage.check(scope),
                        async withdraw(scope: "plugin" | "application") {
                            await removePage.withdraw(scope);
                            if (scope === "plugin" && entries.get(id) === entry) {
                                flushSync(() => { entries.delete(id); publish(); });
                            }
                        },
                    });
                },
                registerAction(action) {
                    if (!active) throw new Error("Navigation layout service is no longer active.");
                    if (!action || typeof action !== "object") throw new TypeError("Navigation action must be an object.");
                    const {id, navigation, run} = action;
                    if (typeof id !== "string" || !id.trim()) throw new Error("Navigation action id cannot be empty.");
                    if (!navigation || typeof navigation.label !== "string" || !navigation.label.trim()) throw new Error("Navigation label cannot be empty.");
                    const item = Object.freeze({id, kind: "action" as const, label: navigation.label, icon: navigation.icon,
                        group: navigation.group ?? "primary", order: navigation.order ?? 0});
                    if (item.group !== "primary" && item.group !== "secondary") throw new Error("Unknown navigation group.");
                    if (!Number.isFinite(item.order)) throw new Error("Navigation order must be finite.");
                    if (typeof run !== "function") throw new Error("Navigation action must have a run function.");
                    if (entries.has(id)) throw new Error(`Navigation entry '${id}' is already registered.`);
                    const entry = {
                        item, run,
                        remove() {
                            if (entries.get(id) !== entry) return;
                            flushSync(() => { entries.delete(id); publish(); });
                        },
                    };
                    entries.set(id, entry);
                    publish();
                    return Object.assign(entry.remove, {
                        associate() {},
                        check() {},
                        withdraw(scope: "plugin" | "application") { if (scope === "plugin") entry.remove(); },
                    });
                },
            };
            context.provide(navigationLayoutKey, Object.freeze(service));
        },
        deactivate() {
            cleanup?.();
            cleanup = undefined;
        },
    };
}
