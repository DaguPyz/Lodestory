import type {Plugin} from "../../plugin-core";
import {uiKey} from "../ui";
import {ContextMenuProvider} from "./ContextMenuProvider";

/** 把上下文菜单能力登记为启动期 UI 包装层。 */
export function createContextMenuPlugin(): Plugin {
    let removeUiWrapper: (() => void) | undefined;

    return {
        id: "context-menu",
        requires: [uiKey],
        provides: [],

        activate(context) {
            removeUiWrapper = context.get(uiKey).addWrapper({
                id: "context-menu",
                order: 10,
                wrap: (children) => <ContextMenuProvider>{children}</ContextMenuProvider>,
            });
        },

        deactivate() {
            const remove = removeUiWrapper;
            removeUiWrapper = undefined;
            remove?.();
        },
    };
}
