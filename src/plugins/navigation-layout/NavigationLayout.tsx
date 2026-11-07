import {useEffect, useState, useSyncExternalStore, type ReactNode} from "react";
import type {NavigationGroup} from "@lodestory/sdk/navigation-layout";
import {BrandLogo} from "@lodestory/ui";
import "../../styles.css";
import "./navigation-layout.css";

export type RegisteredNavigationItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly group: NavigationGroup;
  readonly order: number;
  readonly kind: "page" | "action";
};

type NavigationLayoutProps = {
  readonly pageId: string;
  readonly active: boolean;
  readonly items: readonly RegisteredNavigationItem[];
  readonly subscribeItems: (listener: () => void) => () => void;
  readonly getItems: () => readonly RegisteredNavigationItem[];
  readonly onNavigate: (id: string) => Promise<boolean>;
  readonly children: ReactNode;
};

/** 默认导航外观；不认识作品、设置或其他具体页面。 */
export function NavigationLayout({pageId, active, subscribeItems, getItems, onNavigate, children}: NavigationLayoutProps) {
  const items = useSyncExternalStore(subscribeItems, getItems, getItems);
  const [navigationFailed, setNavigationFailed] = useState(false);
  useEffect(() => { if (!active) setNavigationFailed(false); }, [active]);

  async function navigate(id: string) {
    if (!active || id === pageId) return;
    setNavigationFailed(false);
    try {
      await onNavigate(id);
    } catch (error) {
      console.error("Page navigation failed.", error);
      setNavigationFailed(true);
    }
  }

  function renderItems(group: NavigationGroup) {
    return items.filter(item => item.group === group).map(item => <button
      key={item.id}
      className={`navigation-item${item.icon ? "" : " navigation-item-text"}`}
      type="button"
      aria-current={item.kind === "page" && pageId === item.id ? "page" : undefined}
      aria-label={item.label}
      title={item.label}
      disabled={!active}
      onClick={() => void navigate(item.id)}
    >
      {item.icon && <span className="navigation-icon" aria-hidden="true">{item.icon}</span>}
      <span className="navigation-label">{item.label}</span>
    </button>);
  }

  return <div className="navigation-layout" data-ui-density="spacious">
      <aside className="navigation-panel" aria-label="应用导航">
        <div className="brand">
          <BrandLogo size="brand" />
          <div className="brand-copy">
            <span className="brand-name">Lodestory</span>
            <span className="brand-caption">小说创作工作空间</span>
          </div>
        </div>
        <nav className="navigation-items" aria-label="主导航">{renderItems("primary")}</nav>
        {navigationFailed && <p className="navigation-error" role="alert">操作未能完成，请重试。</p>}
        <nav className="navigation-items navigation-secondary" aria-label="辅助导航">{renderItems("secondary")}</nav>
      </aside>
      {children}
    </div>;
}
