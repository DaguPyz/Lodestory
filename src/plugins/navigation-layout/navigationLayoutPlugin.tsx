import type {Plugin} from "@lodestory/sdk";
import {navigationLayoutKey, type NavigationLayoutService} from "@lodestory/sdk/navigation-layout";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {NavigationLayout, type RegisteredNavigationItem} from "./NavigationLayout";

/** 拥有应用导航布局；页面内容由各插件登记，页面状态和切换仍交给 UI。 */
export function createNavigationLayoutPlugin(): Plugin {
    let cleanup: (() => void) | undefined;

    return {
        id: "navigation-layout",
        requires: [uiKey, themeKey],
        provides: [navigationLayoutKey],
        activate(context) {
            const ui = context.get(uiKey);
            const entries = new Map<string, { item: RegisteredNavigationItem; remove: () => void }>();
            let active = true;

            const items = () => [...entries.values()].map(entry => entry.item).sort((a, b) =>
                (a.group === b.group ? 0 : a.group === "primary" ? -1 : 1)
                || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

            cleanup = () => {
                // UI 撤销会先卸载组件；条目及页面资源保留到撤销完成。
                for (const entry of [...entries.values()].reverse()) entry.remove();
                active = false;
            };

            const service: NavigationLayoutService = {
                registerPage(page) {
                    if (!active) throw new Error("Navigation layout service is no longer active.");
                    const {id, render} = page;
                    const item = Object.freeze({
                        id,
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
                        render: pageContext => <NavigationLayout
                            pageId={id}
                            active={pageContext.active}
                            items={items()}
                            onNavigate={target => ui.openPage(target)}
                        >{render(pageContext)}</NavigationLayout>,
                    });
                    const entry = {
                        item,
                        remove() {
                            if (entries.get(id) !== entry) return;
                            removePage();
                            entries.delete(id);
                        },
                    };
                    entries.set(id, entry);
                    return entry.remove;
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
