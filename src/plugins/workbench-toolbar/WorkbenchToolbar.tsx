import {useEffect, useId, useRef, useSyncExternalStore} from "react";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import { Button, IconButton, Icon } from "@lodestory/ui";
import {useContextMenus} from "../context-menu";
import type {WorkbenchToolbarModel} from "./workbenchToolbarModel";
import {workbenchToolbarId} from "./workbenchToolbarIds";
import "./workbench-toolbar.css";

type ToolbarServices = {
  workbench: WorkbenchService;
  layout: LayoutService;
  models: ReadonlyMap<string, WorkbenchToolbarModel>;
};

export function WorkbenchToolbar({workbench, layout, models, active}: ToolbarServices & {active: boolean}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const model = session && models.get(session.id);
  return session && model ? <ToolbarView key={session.id} model={model} layout={layout}
    projectName={session.project.name} enabled={active && state.active && !state.busy}/> : null;
}

function ToolbarView({model, layout, projectName, enabled}: {
  model: WorkbenchToolbarModel;
  layout: LayoutService;
  projectName: string;
  enabled: boolean;
}) {
  const {focusMode} = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const snapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const contentMenu = useRef<HTMLDetailsElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const menuOwner = useId();
  const projectOwner = `${menuOwner}.project`;
  const contentOwner = `${menuOwner}.contents`;
  const menus = useContextMenus();
  const shown = (id: string) => snapshot.shownIds.includes(id);

  function perform(action: () => unknown) {
    if (!enabled) return;
    try { void Promise.resolve(action()).catch(error => console.error("Workbench toolbar operation failed.", {error})); }
    catch (error) { console.error("Workbench toolbar operation failed.", {error}); }
  }

  useEffect(() => {
    if (!enabled) {
      if (projectMenu.current) projectMenu.current.open = false;
      if (contentMenu.current) contentMenu.current.open = false;
      menus.release(projectOwner);
      menus.release(contentOwner);
      return;
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      for (const ref of [projectMenu, contentMenu]) {
        if (ref.current?.open && !ref.current.contains(event.target)) ref.current.open = false;
      }
    }
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      const menu = projectMenu.current?.open ? projectMenu.current : contentMenu.current?.open ? contentMenu.current : null;
      if (menu) {
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        menu.querySelector("summary")?.focus();
      } else if (focusMode) {
        event.preventDefault();
        try { if (model.exitFocus()) focusButton.current?.focus(); }
        catch (error) { console.error("Could not exit focus mode.", {error}); }
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
    };
  }, [enabled, focusMode, model, menus, projectOwner, contentOwner]);

  useEffect(() => () => {
    menus.release(projectOwner);
    menus.release(contentOwner);
  }, [menus, projectOwner, contentOwner]);

  function menuToggled(ref: {current: HTMLDetailsElement | null}, owner: string) {
    if (ref.current?.open && enabled) menus.activate(owner, () => { if (ref.current) ref.current.open = false; });
    else {
      if (ref.current) ref.current.open = false;
      menus.release(owner);
    }
  }

  return <div className="workbench-toolbar" role="toolbar" aria-label="工作台工具栏">
    <div className="toolbar-project-actions">
      <div className="toolbar-brand" aria-label="Lodestory"><Icon name="book" size="large"/><span>Lodestory</span></div>
      <details className="toolbar-project-menu" ref={projectMenu} onToggle={() => menuToggled(projectMenu, projectOwner)}>
        <summary className="toolbar-project-trigger" title={projectName} aria-disabled={!enabled || undefined}
          tabIndex={enabled ? 0 : -1} onClick={event => { if (!enabled) event.preventDefault(); }}>
          <span>{projectName}</span><Icon name="chevronDown" size="small"/>
        </summary>
        <div className="toolbar-project-popover">
          <Button variant="ghost" disabled={!enabled} onClick={() => {
            if (projectMenu.current) projectMenu.current.open = false;
            perform(model.leaveProject);
          }}><Icon name="arrowLeft"/>返回欢迎页</Button>
          <Button variant="ghost" disabled={!enabled} onClick={() => {
            if (projectMenu.current) projectMenu.current.open = false;
            perform(model.openSettings);
          }}><Icon name="settings"/>外观设置</Button>
        </div>
      </details>
      <div className="toolbar-common-actions">
        <IconButton label="搜索项目" disabled><Icon name="search"/></IconButton>
        <IconButton label="设置" disabled={!enabled} onClick={() => perform(model.openSettings)}><Icon name="settings"/></IconButton>
      </div>
    </div>
    <div className="toolbar-controls">
      {snapshot.contents.filter(entry => entry.role === "navigation").map(entry => <span className="toolbar-navigation-toggle" key={entry.id}>
        <IconButton label={entry.title} disabled={!enabled} aria-pressed={shown(entry.id)}
          onClick={() => perform(() => model.toggleContent(entry.id))}><Icon name="file"/></IconButton>
      </span>)}
      {snapshot.contents.filter(entry => entry.role === "auxiliary").map(entry => <span className="toolbar-auxiliary-toggle" key={entry.id}>
        <IconButton label={`${shown(entry.id) ? "收起" : "显示"}${entry.title}`} disabled={!enabled} aria-pressed={shown(entry.id)}
          onClick={() => perform(() => model.toggleContent(entry.id))}><Icon name="split"/></IconButton>
      </span>)}
      <button className="button button--ghost toolbar-focus-button" type="button" ref={focusButton} disabled={!enabled}
        aria-label={focusMode ? "退出专注模式" : "专注模式"} aria-pressed={focusMode}
        onClick={() => perform(focusMode ? model.exitFocus : model.enterFocus)}>
        <Icon name="focus"/><span>{focusMode ? "退出专注" : "专注模式"}</span>
      </button>
      <details className="toolbar-content-menu" ref={contentMenu} onToggle={() => menuToggled(contentMenu, contentOwner)}>
        <summary className="icon-button" aria-label="布局内容" title="布局内容" aria-disabled={!enabled || undefined}
          tabIndex={enabled ? 0 : -1} onClick={event => { if (!enabled) event.preventDefault(); }}><Icon name="more"/></summary>
        <div className="toolbar-content-options" aria-label="显示或隐藏内容">
          {snapshot.contents.filter(entry => entry.id !== workbenchToolbarId).map(entry => <Button key={entry.id}
            variant="ghost" disabled={!enabled} aria-pressed={shown(entry.id)} onClick={() => perform(() => model.toggleContent(entry.id))}>
            {shown(entry.id) ? "隐藏" : "显示"}{entry.title}
          </Button>)}
        </div>
      </details>
    </div>
  </div>;
}

/** 独立于 actions 内容挂载，工具栏自身被隐藏后仍可恢复。 */
export function ToolbarRecovery({workbench, layout, models}: ToolbarServices) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const snapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const model = state.session && models.get(state.session.id);
  if (!model || !state.active || state.busy || snapshot.shownIds.includes(workbenchToolbarId)) return null;
  return <div className="toolbar-recovery">
    <Button variant="secondary" onClick={() => {
      try { model.showToolbar(); } catch (error) { console.error("Could not restore workbench toolbar.", {error}); }
    }}><Icon name="more"/>显示工具栏</Button>
  </div>;
}
