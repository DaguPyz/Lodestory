import "../../styles.css";
import type {Plugin} from "../../plugin-core";
import {uiKey} from "../ui";
import {themeKey} from "../theme/themeService";
import App from "../../App";

/** 提供 Lodestory 的业务根组件；统一 UI 插件负责真正创建 React root。 */
export function createAppPlugin(): Plugin {
    let removeRoot: (() => void) | undefined;

    return {
        id: "app",
        requires: [uiKey, themeKey],
        provides: [],

        activate(context) {
            removeRoot = context.get(uiKey).setRoot(() => <App />);
        },

        deactivate() {
            const remove = removeRoot;
            removeRoot = undefined;
            remove?.();
        },
    };
}
