import {useEffect, useState, useSyncExternalStore, type ReactNode} from "react";
import type {NavigationGroup} from "@lodestory/sdk/navigation-layout";
import type {UiService} from "@lodestory/sdk/ui";
import type {I18nService} from "@lodestory/sdk/i18n";
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
  readonly ui: UiService;
  readonly i18n: I18nService;
  readonly children: ReactNode;
};

/** 默认导航外观；不认识作品、设置或其他具体页面。 */
export function NavigationLayout({pageId, active, subscribeItems, getItems, onNavigate, ui, i18n, children}: NavigationLayoutProps) {
  const items = useSyncExternalStore(subscribeItems, getItems, getItems);
  const route = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
  const {t} = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
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

  async function back() {
    if (!active) return;
    setNavigationFailed(false);
    try {if (!await ui.back()) setNavigationFailed(true);}
    catch (error) {console.error("Page navigation failed.", error); setNavigationFailed(true);}
  }

  function renderItems(group: NavigationGroup) {
    return items.filter(item => item.group === group).map(item => {
      const label = t(item.label);
      return <button
        key={item.id}
        className={`navigation-item${item.icon ? "" : " navigation-item-text"}`}
        type="button"
        aria-current={item.kind === "page" && pageId === item.id ? "page" : undefined}
        aria-label={label}
        title={label}
        disabled={!active}
        onClick={() => void navigate(item.id)}
      >
        {item.icon && <span className="navigation-icon" aria-hidden="true">{item.icon}</span>}
        <span className="navigation-label">{label}</span>
      </button>;
    });
  }

  return <div className="navigation-layout" data-ui-density="spacious">
      <aside className="navigation-panel" aria-label={t("应用导航")}>
        <div className="brand">
          <BrandLogo size="brand" />
          <div className="brand-copy">
            <span className="brand-name">Lodestory</span>
            <span className="brand-caption">{t("小说创作工作空间")}</span>
          </div>
        </div>
        <nav className="navigation-items" aria-label={t("主导航")}>{renderItems("primary")}</nav>
        {navigationFailed && <p className="navigation-error" role="alert">{t("操作未能完成，请重试。")}</p>}
        <nav className="navigation-items navigation-secondary" aria-label={t("辅助导航")}>
          {route.canGoBack && <button className="navigation-item navigation-item-text" type="button"
            aria-label={t("返回上一页")} disabled={!active} onClick={() => {void back();}}>
            <span className="navigation-label">{t("返回上一页")}</span>
          </button>}
          {renderItems("secondary")}
        </nav>
      </aside>
      {children}
    </div>;
}
