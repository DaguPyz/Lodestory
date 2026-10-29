import {useEffect, useId, useRef, useState, useSyncExternalStore} from "react";
import {Menu} from "@base-ui/react/menu";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import {BrandLogo, Button, IconButton, Icon} from "@lodestory/ui";
import {useContextMenus} from "../context-menu";
import type {ToolbarSnapshot, WorkbenchToolbarModel} from "./workbenchToolbarModel";
import {workbenchToolbarId} from "./workbenchToolbarIds";
import "./workbench-toolbar.css";

type ToolbarServices = {
  workbench: WorkbenchService;
  layout: LayoutService;
  models: ReadonlyMap<string, WorkbenchToolbarModel>;
};

type MenuCloseReason = "dismiss" | "switch" | "action" | "lifecycle";

const pendingSnapshot: ToolbarSnapshot = Object.freeze({focusMode: false, restoreIds: Object.freeze([])});
const getPendingSnapshot = () => pendingSnapshot;
const subscribePending = () => () => {};

export function WorkbenchToolbar({workbench, layout, models, onSearch, active}: ToolbarServices & {active: boolean; onSearch(sessionId: string): void}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const model = session ? models.get(session.id) : undefined;
  // Project identity is available before this plugin's session participant starts.
  // Keep the same toolbar visible throughout loading; only enable a ready session's actions.
  return session ? <ToolbarView key={session.id} model={model} layout={layout}
    projectName={session.project.name} onSearch={() => onSearch(session.id)}
    enabled={Boolean(model) && active && state.active && !state.busy && !state.loading}/> : null;
}

function ToolbarView({model, layout, projectName, enabled, onSearch}: {
  model?: WorkbenchToolbarModel;
  layout: LayoutService;
  projectName: string;
  enabled: boolean;
  onSearch(): void;
}) {
  const {focusMode} = useSyncExternalStore(model?.subscribe ?? subscribePending,
    model?.getSnapshot ?? getPendingSnapshot, model?.getSnapshot ?? getPendingSnapshot);
  const snapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [instantCloseOwners, setInstantCloseOwners] = useState<ReadonlySet<string>>(() => new Set());
  const [menuDensity, setMenuDensity] = useState("comfortable");
  const toolbar = useRef<HTMLDivElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const menuOwner = useId();
  const projectOwner = `${menuOwner}.project`;
  const contentOwner = `${menuOwner}.contents`;
  const projectTriggerId = `${menuOwner}-project-trigger`;
  const contentTriggerId = `${menuOwner}-content-trigger`;
  const menus = useContextMenus();
  const shown = (id: string) => snapshot.shownIds.includes(id);

  function setInstantClose(owner: string, immediate: boolean) {
    setInstantCloseOwners(current => {
      if (current.has(owner) === immediate) return current;
      const next = new Set(current);
      if (immediate) next.add(owner);
      else next.delete(owner);
      return next;
    });
  }

  function closeFromCoordinator(owner: string, reason: MenuCloseReason) {
    if (reason === "switch" || reason === "lifecycle") setInstantClose(owner, true);
    setOpenMenu(current => current === owner ? null : current);
  }

  function menuOpenChanged(owner: string, nextOpen: boolean, details: Menu.Root.ChangeEventDetails) {
    if (nextOpen) {
      if (!enabled) return;
      setInstantClose(owner, false);
      const densityRoot = toolbar.current?.closest<HTMLElement>("[data-ui-density]");
      setMenuDensity(densityRoot?.dataset.uiDensity ?? "comfortable");
      menus.activate(owner, reason => closeFromCoordinator(owner, reason));
      setOpenMenu(owner);
      return;
    }

    if (details.reason === "item-press" || details.reason === "close-press") {
      setInstantClose(owner, true);
      menus.release(owner);
    }
    setOpenMenu(current => current === owner ? null : current);
  }

  function menuCloseCompleted(owner: string, isOpen: boolean) {
    if (!isOpen && openMenu !== owner) {
      menus.release(owner);
      setInstantClose(owner, false);
    }
  }

  function perform(action: (() => unknown) | undefined) {
    if (!enabled || !action) return;
    try { void Promise.resolve(action()).catch(error => console.error("Workbench toolbar operation failed.", {error})); }
    catch (error) { console.error("Workbench toolbar operation failed.", {error}); }
  }

  useEffect(() => {
    if (enabled) return;
    setInstantClose(projectOwner, true);
    setInstantClose(contentOwner, true);
    setOpenMenu(null);
    menus.release(projectOwner);
    menus.release(contentOwner);
  }, [enabled, menus, projectOwner, contentOwner]);

  useEffect(() => () => {
    menus.release(projectOwner);
    menus.release(contentOwner);
  }, [menus, projectOwner, contentOwner]);

  useEffect(() => {
    if (!enabled || !focusMode) return;
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || openMenu) return;
      event.preventDefault();
      try { if (model?.exitFocus()) focusButton.current?.focus(); }
      catch (error) { console.error("Could not exit focus mode.", {error}); }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [enabled, focusMode, openMenu, model]);

  const projectOpen = enabled && openMenu === projectOwner;
  const contentOpen = enabled && openMenu === contentOwner;
  const menuIsImmediate = (owner: string) => !enabled || instantCloseOwners.has(owner);

  return <div className="workbench-toolbar" role="toolbar" aria-label="工作台工具栏" ref={toolbar}>
    <div className="toolbar-project-actions">
      <div className="toolbar-brand" aria-label="Lodestory"><BrandLogo size="large"/><span>Lodestory</span></div>
      <Menu.Root modal={false} disabled={!enabled} open={projectOpen}
        onOpenChange={(nextOpen, details) => menuOpenChanged(projectOwner, nextOpen, details)}
        onOpenChangeComplete={isOpen => menuCloseCompleted(projectOwner, isOpen)}>
        <Menu.Trigger id={projectTriggerId} render={<Button variant="ghost" data-toolbar-project-trigger aria-label={projectName} title={projectName}/>}>
          <span data-toolbar-project-name>{projectName}</span><Icon name="chevronDown" size="small"/>
        </Menu.Trigger>
        <Menu.Portal className="toolbar-menu-portal" data-ui-density={menuDensity}>
          <Menu.Positioner className="toolbar-menu-positioner" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
            <Menu.Popup className="toolbar-menu-popup" aria-label={`${projectName}项目菜单`}
              data-toolbar-menu-instant={menuIsImmediate(projectOwner) || undefined}>
              <Menu.Item nativeButton={true} render={<Button variant="ghost" data-toolbar-menu-item/>} disabled={!enabled}
                onClick={() => perform(model?.leaveProject)}>返回欢迎页</Menu.Item>
              <Menu.Item nativeButton={true} render={<Button variant="ghost" data-toolbar-menu-item/>} disabled={!enabled}
                onClick={() => perform(model?.openSettings)}>外观设置</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <div className="toolbar-common-actions">
        <IconButton label="搜索项目" disabled={!enabled} onClick={() => perform(onSearch)}><Icon name="search"/></IconButton>
        <IconButton label="设置" disabled={!enabled} onClick={() => perform(model?.openSettings)}><Icon name="settings"/></IconButton>
      </div>
    </div>
    <div className="toolbar-controls">
      {snapshot.contents.filter(entry => entry.role === "navigation").map(entry => <span className="toolbar-navigation-toggle" key={entry.id}>
        <IconButton label={entry.title} disabled={!enabled} aria-pressed={shown(entry.id)}
          onClick={() => perform(() => model?.toggleContent(entry.id))}><Icon name="file"/></IconButton>
      </span>)}
      {snapshot.contents.filter(entry => entry.role === "auxiliary").map(entry => <span className="toolbar-auxiliary-toggle" key={entry.id}>
        <IconButton label={`${shown(entry.id) ? "收起" : "显示"}${entry.title}`} disabled={!enabled} aria-pressed={shown(entry.id)}
          onClick={() => perform(() => model?.toggleContent(entry.id))}><Icon name="split"/></IconButton>
      </span>)}
      <Button variant="ghost" data-toolbar-focus-button ref={focusButton} disabled={!enabled}
        aria-label={focusMode ? "退出专注模式" : "专注模式"} aria-pressed={focusMode}
        onClick={() => perform(focusMode ? model?.exitFocus : model?.enterFocus)}>
        <Icon name="focus"/><span>{focusMode ? "退出专注" : "专注模式"}</span>
      </Button>
      <Menu.Root modal={false} disabled={!enabled} open={contentOpen}
        onOpenChange={(nextOpen, details) => menuOpenChanged(contentOwner, nextOpen, details)}
        onOpenChangeComplete={isOpen => menuCloseCompleted(contentOwner, isOpen)}>
        <Menu.Trigger id={contentTriggerId} render={<IconButton label="布局内容" data-toolbar-content-trigger/>}>
          <Icon name="more"/>
        </Menu.Trigger>
        <Menu.Portal className="toolbar-menu-portal" data-ui-density={menuDensity}>
          <Menu.Positioner className="toolbar-menu-positioner" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
            <Menu.Popup className="toolbar-menu-popup" aria-label="显示或隐藏内容"
              data-toolbar-menu-instant={menuIsImmediate(contentOwner) || undefined}>
              {snapshot.contents.filter(entry => entry.id !== workbenchToolbarId).map(entry => <Menu.Item key={entry.id}
                nativeButton={true} render={<Button variant="ghost" data-toolbar-menu-item/>} disabled={!enabled} closeOnClick={false}
                aria-pressed={shown(entry.id)} onClick={() => perform(() => model?.toggleContent(entry.id))}>
                {shown(entry.id) ? "隐藏" : "显示"}{entry.title}
              </Menu.Item>)}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
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
