import {useLayoutEffect, useRef, useSyncExternalStore} from "react";
import type {LayoutContent, LayoutRole, LayoutViewProps} from "@lodestory/sdk/layout";
import type {ErrorUiService} from "@lodestory/sdk/error";
import {Button, IconButton} from "../../components/Button";
import {Icon} from "../../components/Icon";
import type {LayoutStore} from "./layoutStore";
import type {createNavigationWidthModel} from "./navigationWidth";
import {NavigationResizer} from "./NavigationResizer";
import "./layout.css";

function Content({entry, active}: {entry: LayoutContent; active: boolean}) {
  return entry.render({active});
}

/** 仅消费用途目录；不读取业务 ID、业务 DOM，也不导入任何编辑页组件。 */
export function DefaultLayout({store, widths, active, ErrorBoundary}: LayoutViewProps & {
  store: LayoutStore;
  widths: ReturnType<typeof createNavigationWidthModel>;
  ErrorBoundary: ErrorUiService["ErrorBoundary"];
}) {
  const root = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  const auxiliary = useRef<HTMLElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const {snapshot, navigationDocked, auxiliaryDocked} = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const contents = (role: LayoutRole) => snapshot.contents.filter(entry => entry.role === role);
  const shown = (id: string) => snapshot.shownIds.includes(id);
  const hasShown = (role: LayoutRole) => contents(role).some(entry => shown(entry.id));
  const regionId = (id: string) => `layout-content-${encodeURIComponent(id)}`;

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => store.setViewport(element.getBoundingClientRect().width,
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [store]);

  const toggle = (entry: LayoutContent) => shown(entry.id) ? store.hide(entry.id) : store.show(entry.id);
  function close(entry: LayoutContent) {
    store.hide(entry.id);
    root.current?.querySelector<HTMLButtonElement>(`button[aria-controls="${regionId(entry.id)}"]`)?.focus();
  }

  function renderContent(entry: LayoutContent) {
    return <section key={entry.id} id={regionId(entry.id)} className="layout-content"
      data-content-id={entry.id} hidden={!shown(entry.id)} aria-label={entry.title} tabIndex={-1}>
      <ErrorBoundary><Content entry={entry} active={active && shown(entry.id)}/></ErrorBoundary>
    </section>;
  }

  function panel(role: "navigation" | "auxiliary", docked: boolean) {
    const entries = contents(role);
    const current = entries.find(entry => shown(entry.id));
    return <aside ref={role === "auxiliary" ? auxiliary : undefined} className={`layout-panel layout-${role}`} data-overlay={!docked} hidden={!current}
      aria-label={role === "navigation" ? "导航内容" : "辅助内容"}>
      <div className="layout-panel-header">
        {entries.length > 1 ? <select aria-label={role === "navigation" ? "切换导航内容" : "切换辅助内容"}
          value={current?.id ?? entries[0].id} onChange={event => store.show(event.target.value)}>
          {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
        </select> : <h2>{current?.title ?? entries[0]?.title}</h2>}
        {current && <IconButton label={`收起${current.title}`} onClick={() => close(current)}><Icon name="close" size="small"/></IconButton>}
      </div>
      {entries.map(renderContent)}
      {role === "navigation" && <NavigationResizer widths={widths} root={root} workspace={workspace}
        rail={rail} auxiliary={auxiliary} probe={probe} enabled={active && !!current} docked={docked}
        reserveAuxiliary={auxiliaryDocked && hasShown("auxiliary")} />}
    </aside>;
  }

  return <div className="default-layout" data-ui-density="comfortable" ref={root}>
    <header className="layout-toolbar">
      <div className="layout-actions">{contents("actions").map(renderContent)}</div>
    </header>
    <div ref={workspace} className="layout-workspace" data-navigation-docked={navigationDocked && hasShown("navigation")}
      data-auxiliary-docked={auxiliaryDocked && hasShown("auxiliary")}
      data-has-navigation={contents("navigation").length > 0}>
      <nav ref={rail} className="layout-activitybar" hidden={!contents("navigation").length} aria-label="工作空间工具">
        {contents("navigation").map(entry => <IconButton key={entry.id} label={entry.title} aria-controls={regionId(entry.id)}
          aria-pressed={shown(entry.id)} onClick={() => toggle(entry)}><Icon name="file"/></IconButton>)}
      </nav>
      {panel("navigation", navigationDocked)}
      <main className="layout-main" aria-label="主工作区">
        <div className="layout-tabs" aria-label="文档标签">
          {contents("tabs").map(renderContent)}
        </div>
        {contents("main").length > 1 && <nav className="layout-main-switcher" aria-label="切换主内容">
          {contents("main").map(entry => <Button key={entry.id} variant="ghost" aria-pressed={shown(entry.id)}
            onClick={() => store.show(entry.id)}>{entry.title}</Button>)}
        </nav>}
        {contents("main").map(renderContent)}
        {!hasShown("main") && <p className="layout-empty">从“布局内容”菜单选择要展示的内容。</p>}
      </main>
      {panel("auxiliary", auxiliaryDocked)}
      <div ref={probe} className="layout-navigation-width-probe" aria-hidden="true" />
    </div>
    <footer className="layout-status" hidden={!hasShown("status")} aria-label="工作区状态">
      {contents("status").map(renderContent)}
    </footer>
  </div>;
}
