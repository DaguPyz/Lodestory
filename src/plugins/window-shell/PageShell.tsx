import type {WindowShellProps} from "@lodestory/sdk/window-shell";
import {isTauri} from "@tauri-apps/api/core";
import "./window-shell.css";

/** 默认窗口外壳；平台差异在本插件内处理，页面只传入显示意图和内容。 */
export function PageShell({children, showBrowserTitlebar = true}: WindowShellProps) {
    return <div className="app-shell">
        {showBrowserTitlebar && !isTauri() && <header className="window-titlebar">Lodestory</header>}
        {children}
    </div>;
}
