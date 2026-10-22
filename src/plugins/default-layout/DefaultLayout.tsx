import {useLayoutEffect, useRef, useState, useSyncExternalStore, type AnimationEvent, type RefObject} from "react";
import type {LayoutContent, LayoutRole, LayoutViewProps} from "@lodestory/sdk/layout";
import type {ErrorUiService} from "@lodestory/sdk/error";
import { Button, IconButton, Icon, Select } from "@lodestory/ui";
import type {LayoutStore} from "./layoutStore";
import type {createNavigationWidthModel} from "./navigationWidth";
import {
  completeLayoutPanelEnter,
  completeLayoutPanelExit,
  initialLayoutPanelPresence,
  reconcileLayoutPanelPresence,
} from "./panelPresence";
import {NavigationResizer} from "./NavigationResizer";
import "./layout.css";

function Content({entry, active}: {entry: LayoutContent; active: boolean}) {
  return entry.render({active});
}

type PanelRole = "navigation" | "auxiliary";
type ElementRef = RefObject<HTMLElement | null>;

function noPanelMotion(element: HTMLElement) {
  const style = getComputedStyle(element);
  return style.transitionProperty.split(",").every(value => value.trim() === "none")
    || style.transitionDuration.split(",").every(value => !(Number.parseFloat(value) > 0));
}

function noContentMotion(element: HTMLElement) {
  const style = getComputedStyle(element);
  return style.animationName.split(",").every(value => value.trim() === "none")
    || style.animationDuration.split(",").every(value => !(Number.parseFloat(value) > 0));
}

function reduceMotionRequested() {
  return document.documentElement.dataset.uiMotion === "reduce"
    || typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function LayoutPanel({role, entries, shownIds, docked, active, store, widths, root, workspace, rail, auxiliary, probe,
  reserveAuxiliary, onClose, onAsideElement, ErrorBoundary}: {
  role: PanelRole;
  entries: LayoutContent[];
  shownIds: readonly string[];
  docked: boolean;
  active: boolean;
  store: LayoutStore;
  widths: ReturnType<typeof createNavigationWidthModel>;
  root: ElementRef;
  workspace: ElementRef;
  rail: ElementRef;
  auxiliary: ElementRef;
  probe: ElementRef;
  reserveAuxiliary: boolean;
  onClose: (entry: LayoutContent) => void;
  onAsideElement?: (element: HTMLElement | null) => void;
  ErrorBoundary: ErrorUiService["ErrorBoundary"];
}) {
  const panel = useRef<HTMLElement>(null);
  const [presence, setPresence] = useState(initialLayoutPanelPresence);
  const [fadeContentId, setFadeContentId] = useState<string | null>(null);
  const previousCurrent = useRef<string | null>(null);
  const previousDocked = useRef(docked);
  const previousActive = useRef(active);
  const current = entries.find(entry => shownIds.includes(entry.id));
  const currentId = current?.id ?? null;
  const allowOverlayMotion = !docked && active;

  useLayoutEffect(() => {
    setPresence(previous => reconcileLayoutPanelPresence(previous, currentId, allowOverlayMotion));
  }, [currentId, allowOverlayMotion]);

  useLayoutEffect(() => {
    const dockedChanged = docked !== previousDocked.current;
    const shouldFade = currentId !== null && previousCurrent.current === null && docked
      && !dockedChanged && active && previousActive.current && !reduceMotionRequested();
    if (currentId !== previousCurrent.current || dockedChanged || active !== previousActive.current) {
      setFadeContentId(shouldFade ? currentId : null);
      previousCurrent.current = currentId;
      previousDocked.current = docked;
      previousActive.current = active;
    }
  }, [currentId, docked, active]);

  useLayoutEffect(() => {
    if (presence.phase !== "entering") return;
    const element = panel.current;
    if (!element) return;
    const finish = () => setPresence(previous => completeLayoutPanelEnter(previous, presence.revision));
    if (document.visibilityState === "hidden" || noPanelMotion(element) || typeof requestAnimationFrame !== "function") {
      finish();
      return;
    }
    const frame = requestAnimationFrame(finish);
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") finish(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [presence.phase, presence.revision]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const onAnimationCancel = (event: globalThis.AnimationEvent) => {
      if (event.animationName !== "layout-dock-content-enter" || !(event.target instanceof HTMLElement)) return;
      const id = event.target.dataset.contentId;
      if (id) setFadeContentId(previous => previous === id ? null : previous);
    };
    element.addEventListener("animationcancel", onAnimationCancel);
    return () => element.removeEventListener("animationcancel", onAnimationCancel);
  }, []);

  useLayoutEffect(() => {
    if (!fadeContentId || !panel.current) return;
    const section = Array.from(panel.current.querySelectorAll<HTMLElement>(".layout-content"))
      .find(element => element.dataset.contentId === fadeContentId);
    if (section && (reduceMotionRequested() || noContentMotion(section))) {
      setFadeContentId(previous => previous === fadeContentId ? null : previous);
    }
    const finishIfReduced = () => {
      if (reduceMotionRequested()) setFadeContentId(previous => previous === fadeContentId ? null : previous);
    };
    const observer = new MutationObserver(finishIfReduced);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-ui-motion"]});
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    media?.addEventListener("change", finishIfReduced);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", finishIfReduced);
    };
  }, [fadeContentId]);

  useLayoutEffect(() => {
    if (presence.phase !== "exiting") return;
    const element = panel.current;
    if (!element) return;
    // Resolve style first so the browser has created its CSS transitions before they are observed.
    void getComputedStyle(element).opacity;
    const animations = element.getAnimations();
    const finish = () => setPresence(previous => completeLayoutPanelExit(previous, presence.revision));
    if (document.visibilityState === "hidden" || animations.length === 0) {
      finish();
      return;
    }
    let cancelled = false;
    Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!cancelled) finish();
    });
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") finish(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [presence.phase, presence.revision]);

  const retainingExit = !current && !docked && presence.id !== null;
  const presentationId = currentId ?? (retainingExit ? presence.id : null);
  const presentationEntry = entries.find(entry => entry.id === presentationId);
  const exiting = retainingExit || presence.phase === "exiting";
  const panelActive = active && current !== undefined;

  function clearContentFade(event: AnimationEvent<HTMLElement>, id: string) {
    if (event.currentTarget !== event.target || event.animationName !== "layout-dock-content-enter") return;
    setFadeContentId(previous => previous === id ? null : previous);
  }

  return <aside ref={element => {
    panel.current = element;
    onAsideElement?.(element);
  }} className={`layout-panel layout-${role}`} data-overlay={!docked}
    data-panel-phase={presence.phase} data-open={presence.phase === "open"}
    data-motion-enabled={allowOverlayMotion} hidden={!presentationId}
    aria-hidden={!panelActive} inert={!panelActive || exiting}
    aria-label={role === "navigation" ? "导航内容" : "辅助内容"}>
    <div className="layout-panel-header">
      {entries.length > 1 ? <div className="layout-panel-switcher"><Select variant="title" aria-label={role === "navigation" ? "切换导航内容" : "切换辅助内容"}
        value={presentationEntry?.id ?? entries[0].id} onValueChange={id => store.show(id)}
        options={entries.map(entry => ({value: entry.id, label: entry.title}))} /></div> : <h2>{presentationEntry?.title ?? entries[0]?.title}</h2>}
      {presentationEntry && <IconButton label={`收起${presentationEntry.title}`} onClick={() => onClose(presentationEntry)}><Icon name="close" size="small"/></IconButton>}
    </div>
    {entries.map(entry => {
      const isCurrent = currentId === entry.id;
      const isPresentation = presentationId === entry.id;
      const visible = isCurrent || (exiting && isPresentation);
      const contentActive = active && isCurrent;
      return <section key={entry.id} id={`layout-content-${encodeURIComponent(entry.id)}`} className="layout-content"
        data-content-id={entry.id} data-entering={fadeContentId === entry.id}
        hidden={!visible} aria-hidden={!contentActive} inert={!contentActive}
        onAnimationEnd={event => clearContentFade(event, entry.id)}
        aria-label={entry.title} tabIndex={-1}>
        <ErrorBoundary><Content entry={entry} active={contentActive}/></ErrorBoundary>
      </section>;
    })}
    {role === "navigation" && <NavigationResizer widths={widths} root={root} workspace={workspace}
      rail={rail} auxiliary={auxiliary} probe={probe} enabled={active && !!current} docked={docked}
      reserveAuxiliary={reserveAuxiliary} />}
  </aside>;
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
    const target = root.current?.querySelector<HTMLButtonElement>(`button[aria-controls="${regionId(entry.id)}"]`)
      ?? root.current?.querySelector<HTMLElement>(".layout-main");
    target?.focus();
  }

  function renderContent(entry: LayoutContent) {
    return <section key={entry.id} id={regionId(entry.id)} className="layout-content"
      data-content-id={entry.id} hidden={!shown(entry.id)} aria-label={entry.title} tabIndex={-1}>
      <ErrorBoundary><Content entry={entry} active={active && shown(entry.id)}/></ErrorBoundary>
    </section>;
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
          aria-pressed={shown(entry.id)} onClick={() => toggle(entry)}>{entry.icon ?? <Icon name="file"/>}</IconButton>)}
      </nav>
      <LayoutPanel role="navigation" entries={contents("navigation")} shownIds={snapshot.shownIds}
        docked={navigationDocked} active={active} store={store} widths={widths} root={root}
        workspace={workspace} rail={rail} auxiliary={auxiliary} probe={probe}
        reserveAuxiliary={auxiliaryDocked && hasShown("auxiliary")} onClose={close} ErrorBoundary={ErrorBoundary}/>
      <main className="layout-main" aria-label="主工作区" tabIndex={-1}>
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
      <LayoutPanel role="auxiliary" entries={contents("auxiliary")} shownIds={snapshot.shownIds}
        docked={auxiliaryDocked} active={active} store={store} widths={widths} root={root}
        workspace={workspace} rail={rail} auxiliary={auxiliary} probe={probe}
        reserveAuxiliary={false} onClose={close} onAsideElement={element => { auxiliary.current = element; }}
        ErrorBoundary={ErrorBoundary}/>
      <div ref={probe} className="layout-navigation-width-probe" aria-hidden="true" />
    </div>
    <footer className="layout-status" hidden={!hasShown("status")} aria-label="工作区状态">
      {contents("status").map(renderContent)}
    </footer>
  </div>;
}
