import { Menu } from "@base-ui/react/menu";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeSettingsPage } from "./ThemeSettingsPage";
import { NewProjectDialog } from "./NewProjectDialog";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { SearchField } from "../components/SearchField";
import { ContextMenuRegion, useContextMenus, type MenuAction } from "../components/context-menu";
import {
  createProject, isUnavailableError, listRecentProjects, openProject, pickProjectDirectory,
  projectErrorMessage, relocateProject, removeRecentProject,
  type OpenedProject, type ProjectRecord, type RecentProject,
} from "../projects/projectApi";
import { formatLastOpened, projectPathSeparator } from "../projects/projectDisplay";

function ProjectPath({ path, id }: { path: string; id: string }) {
  const separator = projectPathSeparator(path);

  return (
    <span className="project-path" id={id} title={path}>
      <span className="project-path-prefix">{separator < 0 ? "" : path.slice(0, separator)}</span>
      <span className="project-path-name">{separator < 0 ? path : path.slice(separator)}</span>
    </span>
  );
}

export type WelcomeSection = "projects" | "settings";

type WelcomePageProps = {
  active: boolean;
  section: WelcomeSection;
  onSectionChange: (section: WelcomeSection) => void;
  onOpenProject: (project: ProjectRecord) => void;
  onBackFromSettings?: () => void;
};

export function WelcomePage({ active, section, onSectionChange, onOpenProject, onBackFromSettings }: WelcomePageProps) {
  const menus = useContextMenus();
  const [moreProject, setMoreProject] = useState<string | null>(null);
  const projectsButton = useRef<HTMLButtonElement>(null);
  const operationPending = useRef(false);
  const loadSequence = useRef(0);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const desktop = isTauri();
  const disabled = !desktop || busy || loading;
  const query = search.trim().toLocaleLowerCase();
  const matchingProjects = projects.filter((project) =>
    `${project.name}\n${project.path}`.toLocaleLowerCase().includes(query));

  useEffect(() => {
    if (createDialogOpen) menus.closeAll();
  }, [createDialogOpen, menus]);

  useEffect(() => {
    return () => { if (moreProject) menus.release(`recent-project-more:${moreProject}`); };
  }, [moreProject, menus]);

  const reload = useCallback(async () => {
    if (operationPending.current) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const records = await listRecentProjects();
      if (sequence !== loadSequence.current) return;
      setProjects(records);
      setLoadFailed(false);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setLoadFailed(true);
      setError(projectErrorMessage(cause));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void reload();
    return () => { loadSequence.current += 1; };
  }, [active, reload]);

  async function runAction<T,>(action: () => Promise<T>): Promise<T | undefined> {
    if (operationPending.current || loading) return undefined;
    operationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(projectErrorMessage(cause));
      return undefined;
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  function enterProject(opened: OpenedProject) {
    setProjects(opened.projects);
    setLoadFailed(false);
    onOpenProject(opened.project);
  }

  async function openDirectory() {
    await runAction(async () => {
      const path = await pickProjectDirectory("打开项目目录");
      if (path) enterProject(await openProject(path));
    });
  }

  async function openRecent(project: RecentProject) {
    if (!project.available) {
      await relocate(project);
      return;
    }
    await runAction(async () => {
      try {
        enterProject(await openProject(project.path));
      } catch (cause) {
        if (isUnavailableError(cause)) {
          setProjects((records) => records.map((record) => record.id === project.id ? { ...record, available: false } : record));
        }
        throw cause;
      }
    });
  }

  async function relocate(project: RecentProject) {
    await runAction(async () => {
      const path = await pickProjectDirectory(`重新定位 ${project.name}`);
      if (path) enterProject(await relocateProject(project.id, path));
    });
  }

  async function remove(project: RecentProject) {
    await runAction(async () => {
      setProjects(await removeRecentProject(project.id));
      setLoadFailed(false);
      requestAnimationFrame(() => {
        const next = document.querySelector<HTMLButtonElement>(".project-entry:not(:disabled)")
          ?? document.getElementById("recent-projects-heading");
        next?.focus();
      });
    });
  }

  function projectActions(id: string): MenuAction<string>[] {
    const project = projects.find((record) => record.id === id);
    async function perform(targetId: string, action: "open" | "relocate" | "remove") {
      const target = projects.find((record) => record.id === targetId);
      if (!target || disabled || !active || section !== "projects") return;
      if (action === "open") { if (target.available) await openRecent(target); }
      else if (action === "relocate") await relocate(target);
      else await remove(target);
    }
    return [
      { id: "open", label: "打开项目", icon: <Icon name="folder" />, disabled: disabled || !project?.available, restoreFocus: false, onSelect: (target) => perform(target, "open") },
      { id: "relocate", label: "重新定位目录", disabled: disabled || !project, restoreFocus: false, onSelect: (target) => perform(target, "relocate") },
      { id: "remove", label: "从最近项目移除", disabled: disabled || !project, restoreFocus: false, onSelect: (target) => perform(target, "remove") },
    ];
  }

  async function create(parentPath: string, name: string) {
    await runAction(async () => {
      const opened = await createProject(parentPath, name);
      setCreateDialogOpen(false);
      setSearch("");
      enterProject(opened);
    });
  }

  function returnToProjects() {
    if (onBackFromSettings) {
      onBackFromSettings();
      return;
    }
    onSectionChange("projects");
    projectsButton.current?.focus();
  }

  return (
    <div className="welcome-layout" data-ui-density="spacious">
      <aside className="navigation-panel" aria-label="应用导航">
        <div className="brand">
          <Icon name="book" size="brand" />
          <div className="brand-copy">
            <span className="brand-name">Lodestory</span>
            <span className="brand-caption">小说创作工作空间</span>
          </div>
        </div>

        <nav className="navigation-items" aria-label="主导航">
          <button
            ref={projectsButton}
            className="navigation-item"
            type="button"
            aria-current={section === "projects" ? "page" : undefined}
            aria-label="作品"
            title="作品"
            onClick={() => onSectionChange("projects")}
          >
            <Icon name="folder" />
            <span>作品</span>
          </button>
        </nav>

        <button
          className="navigation-item navigation-settings"
          type="button"
          aria-current={section === "settings" ? "page" : undefined}
          aria-label="设置"
          title="设置"
          onClick={() => onSectionChange("settings")}
        >
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </aside>

      <main className="welcome-workspace" hidden={section !== "projects"} aria-labelledby="welcome-page-heading">
        <div className="welcome-content">
          <header className="welcome-header">
            <div className="welcome-heading">
              <h1 id="welcome-page-heading" tabIndex={-1}>欢迎使用 Lodestory</h1>
              <p>继续写作，或开始一个新故事。</p>
            </div>
            <div className="welcome-actions" aria-label="项目操作">
              <Button variant="primary" disabled={disabled} onClick={() => { setError(null); setCreateDialogOpen(true); }}>
                <Icon name="plus" />开始新创作
              </Button>
              <Button disabled={disabled} onClick={() => void openDirectory()}><Icon name="folder" />打开已有作品</Button>
            </div>
          </header>

          <section className="recent-projects" aria-labelledby="recent-projects-heading">
            <div className="section-toolbar">
              <h2 id="recent-projects-heading" tabIndex={-1}>最近项目</h2>
              <SearchField label="搜索项目" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>

            {error && !createDialogOpen && <div className="project-feedback" role="alert">
              <p className="project-error">{error}</p>
              <Button variant="ghost" onClick={() => void reload()} disabled={busy || loading}>刷新列表</Button>
            </div>}
            {loading ? <p className="project-list-message" role="status">正在加载最近项目…</p>
              : !loadFailed && matchingProjects.length === 0 && <div className="project-list-message" role="status">
                <p>{query ? "没有找到匹配的项目。" : "还没有最近项目。"}</p>
                {!query && <p>{desktop ? "新建项目，或打开已有的小说目录。" : "请在桌面应用中创建或打开项目。"}</p>}
              </div>}

            <ul className="project-list" aria-label="最近打开的小说项目" aria-busy={busy || loading}>
              {matchingProjects.map((project) => (
                <ContextMenuRegion key={project.id} context={project.id} label={`${project.name}项目操作`} items={projectActions}>
                <li className="project-row" key={project.id}>
                  <button
                    className="project-entry"
                    type="button"
                    aria-label={`${project.available ? "打开项目" : "重新定位项目"} ${project.name}`}
                    aria-describedby={`project-path-${project.id}`}
                    disabled={disabled}
                    onClick={() => void openRecent(project)}
                  >
                    <Icon name="folder" />
                    <span className="project-details">
                      <span className="project-name" title={project.name}>{project.name}</span>
                      <ProjectPath path={project.path} id={`project-path-${project.id}`} />
                      {!project.available && <span className="project-unavailable">目录不可用，点击重新定位</span>}
                    </span>
                    <time className="project-time" dateTime={project.lastOpenedAt}>{formatLastOpened(project.lastOpenedAt)}</time>
                  </button>
                  <Menu.Root modal={false} open={moreProject === project.id} onOpenChange={(open) => {
                    const id = `recent-project-more:${project.id}`;
                    if (open) { menus.activate(id, () => setMoreProject(null)); setMoreProject(project.id); }
                    else { menus.release(id); setMoreProject((current) => current === project.id ? null : current); }
                  }}>
                    <Menu.Trigger className="icon-button" aria-label={`${project.name}的更多操作`} title={`${project.name}的更多操作`} disabled={disabled}>
                      <Icon name="more" />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner className="project-menu-positioner" sideOffset={8} align="end">
                        <Menu.Popup className="project-menu" data-ui-density="comfortable">
                          {projectActions(project.id).filter((action) => action.id !== "open").map((action) => (
                            <Menu.Item key={action.id} className="project-menu-item" disabled={action.disabled as boolean} onClick={() => {
                              menus.closeAll("action");
                              void action.onSelect(project.id);
                            }}>{action.label}</Menu.Item>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                </li>
                </ContextMenuRegion>
              ))}
            </ul>
          </section>
        </div>

        <footer className="welcome-footer">一个目录，一部小说。</footer>
      </main>
      <ThemeSettingsPage visible={section === "settings"} onBack={returnToProjects} />
      {createDialogOpen && <NewProjectDialog busy={busy} error={error} onClose={() => setCreateDialogOpen(false)}
        onPickDirectory={() => runAction(() => pickProjectDirectory("选择项目保存位置"))} onCreate={create} />}
    </div>
  );
}
