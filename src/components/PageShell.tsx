import type {ReactNode} from "react";
import {isTauri} from "@tauri-apps/api/core";
import "../styles.css";

type PageShellProps = {
  children: ReactNode;
  showBrowserTitlebar?: boolean;
};

/** Owns the application shell and the browser-only titlebar shared by full pages. */
export function PageShell({children, showBrowserTitlebar = true}: PageShellProps) {
  return <div className="app-shell">
    {showBrowserTitlebar && !isTauri() && <header className="window-titlebar">Lodestory</header>}
    {children}
  </div>;
}
