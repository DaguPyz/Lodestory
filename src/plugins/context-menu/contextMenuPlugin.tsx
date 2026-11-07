import type {Plugin} from "@lodestory/sdk";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {uiKey} from "@lodestory/sdk/ui";
import {ContextMenuRegion} from "./ContextMenuRegion";
import {ContextMenuProvider} from "./ContextMenuProvider";

/** 把上下文菜单能力登记为启动期 UI 包装层。 */
export function createContextMenuPlugin(): Plugin {
    let removeUiWrapper: (() => void) | undefined;

    return {
        id: "context-menu",
        requires: [uiKey],
        provides: [contextMenuKey],

        activate(context) {
            context.provide(contextMenuKey, {Region: ContextMenuRegion});
            removeUiWrapper = context.track(context.get(uiKey).addWrapper({
                id: "context-menu",
                order: 10,
                wrap: (children) => <ContextMenuProvider>{children}</ContextMenuProvider>,
            }));
        },

        deactivate() {
            const remove = removeUiWrapper;
            removeUiWrapper = undefined;
            remove?.();
        },
    };
}
