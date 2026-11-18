import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { I18nService } from "@lodestory/sdk/i18n";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import { Button, Icon, SearchField } from "@lodestory/ui";
import { ContextMenuRegion, useContextMenus, type MenuAction } from "../context-menu";
import {
  createProject, isUnavailableError, listRecentProjects, openProject, pickProjectDirectory,
  projectErrorMessage, relocateProject, removeRecentProject,
  type OpenedProject, type ProjectRecord, type RecentProject,
} from "../../projects/projectApi";
import { formatLastOpened, projectPathSeparator } from "../../projects/projectDisplay";

function ProjectPath({ path, id }: { path: string; id: string }) {
  const separator = projectPathSeparator(path);

  return (
    <span className="project-path" id={id} title={path}>
      <span className="project-path-prefix">{separator < 0 ? "" : path.slice(0, separator)}</span>
      <span className="project-path-name">{separator < 0 ? path : path.slice(separator)}</span>
    </span>
  );
}

type WelcomePageProps = {
  active: boolean;
  i18n: I18nService;
  onOpenProject: (project: ProjectRecord) => void | Promise<unknown>;
};

export function WelcomePage({ active, i18n, onOpenProject }: WelcomePageProps) {
  const menus = useContextMenus();
  const {locale, t} = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
  const dateDisplay = {
    locale,
    today: (time: string) => t("今天 {time}", {values: {time}}),
    yesterday: (time: string) => t("昨天 {time}", {values: {time}}),
    unknown: t("时间未知"),
  };
  const heading = useRef<HTMLHeadingElement>(null);
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
  const disabled = !active || !desktop || busy || loading;
  const query = search.trim().toLocaleLowerCase();
  const matchingProjects = projects.filter((project) =>
    `${project.name}\n${project.path}`.toLocaleLowerCase().includes(query));

  useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (createDialogOpen) menus.closeAll();
  }, [createDialogOpen, menus]);

  useEffect(() => {
    if (active) return;
    setCreateDialogOpen(false);
    menus.closeAll();
  }, [active, menus]);

  const reload = useCallback(async () => {
    if (!active || operationPending.current) return;
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
  }, [active]);

  useEffect(() => {
    if (active) void reload();
    return () => { loadSequence.current += 1; };
  }, [active, reload]);

  async function runAction<T,>(action: () => Promise<T>): Promise<T | undefined> {
    if (!active || operationPending.current || loading) return undefined;
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

  async function enterProject(opened: OpenedProject) {
    setProjects(opened.projects);
    setLoadFailed(false);
    await onOpenProject(opened.project);
  }

  async function openDirectory() {
    await runAction(async () => {
      const path = await pickProjectDirectory(t("打开项目目录"));
      if (path) await enterProject(await openProject(path));
    });
  }

  async function openRecent(project: RecentProject) {
    if (!project.available) {
      await relocate(project);
      return;
    }
    await runAction(async () => {
      try {
        await enterProject(await openProject(project.path));
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
      const path = await pickProjectDirectory(t("重新定位 {name}", {values: {name: project.name}}));
      if (path) await enterProject(await relocateProject(project.id, path));
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
      if (!target || disabled || !active) return;
      if (action === "open") { if (target.available) await openRecent(target); }
      else if (action === "relocate") await relocate(target);
      else await remove(target);
    }
    return [
      { id: "open", label: t("打开项目"), icon: <Icon name="folder" />, disabled: disabled || !project?.available, restoreFocus: false, onSelect: (target) => perform(target, "open") },
      { id: "relocate", label: t("重新定位目录"), disabled: disabled || !project, restoreFocus: false, onSelect: (target) => perform(target, "relocate") },
      { id: "remove", label: t("从最近项目移除"), disabled: disabled || !project, restoreFocus: false, onSelect: (target) => perform(target, "remove") },
    ];
  }

  async function create(parentPath: string, name: string) {
    await runAction(async () => {
      const opened = await createProject(parentPath, name);
      setCreateDialogOpen(false);
      setSearch("");
      await enterProject(opened);
    });
  }

  return (
    <>
      <main className="welcome-workspace" aria-labelledby="welcome-page-heading">
        <div className="welcome-content">
          <header className="welcome-header">
            <div className="welcome-heading">
              <h1 id="welcome-page-heading" ref={heading} tabIndex={-1}>{t("欢迎使用 Lodestory")}</h1>
              <p>{t("继续写作，或开始一个新故事。")}</p>
            </div>
            <div className="welcome-actions" aria-label={t("项目操作")}>
              <Button variant="primary" disabled={disabled} onClick={() => { setError(null); setCreateDialogOpen(true); }}>
                <Icon name="plus" />{t("开始新创作")}
              </Button>
              <Button variant="secondary" disabled={disabled} onClick={() => void openDirectory()}><Icon name="folder" />{t("打开已有作品")}</Button>
            </div>
          </header>

          <section className="recent-projects" aria-labelledby="recent-projects-heading">
            <div className="section-toolbar">
              <h2 id="recent-projects-heading" tabIndex={-1}>{t("最近项目")}</h2>
              <SearchField label={t("搜索项目", {namespace: "welcome"})} value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>

            {error && !createDialogOpen && <div className="project-feedback" role="alert">
              <p className="project-error">{error}</p>
              <Button variant="ghost" onClick={() => void reload()} disabled={busy || loading}>{t("刷新列表")}</Button>
            </div>}
            {loading ? <p className="project-list-message" role="status">{t("正在加载最近项目…")}</p>
              : !loadFailed && matchingProjects.length === 0 && <div className="project-list-message" role="status">
                <p>{t(query ? "没有找到匹配的项目。" : "还没有最近项目。")}</p>
                {!query && <p>{t(desktop ? "新建项目，或打开已有的小说目录。" : "请在桌面应用中创建或打开项目。")}</p>}
              </div>}

            <ul className="project-list" aria-label={t("最近打开的小说项目")} aria-busy={busy || loading}>
              {matchingProjects.map((project) => (
                <ContextMenuRegion key={project.id} context={project.id} label={t("{name}项目操作", {values: {name: project.name}})} items={projectActions}>
                <li className="project-row" key={project.id}>
                  <button
                    className="project-entry"
                    type="button"
                    aria-label={t(project.available ? "打开项目 {name}" : "重新定位项目 {name}", {values: {name: project.name}})}
                    aria-describedby={`project-path-${project.id}`}
                    disabled={disabled}
                    onClick={() => void openRecent(project)}
                  >
                    <Icon name="folder" />
                    <span className="project-details">
                      <span className="project-name" title={project.name}>{project.name}</span>
                      <ProjectPath path={project.path} id={`project-path-${project.id}`} />
                      {!project.available && <span className="project-unavailable">{t("目录不可用，点击重新定位")}</span>}
                    </span>
                    <time className="project-time" dateTime={project.lastOpenedAt}>{formatLastOpened(project.lastOpenedAt, undefined, dateDisplay)}</time>
                  </button>
                  <ProjectActionsMenu projectId={project.id} label={t("{name}的更多操作", {values: {name: project.name}})}
                    disabled={disabled} actions={projectActions(project.id)} />
                </li>
                </ContextMenuRegion>
              ))}
            </ul>
          </section>
        </div>

        <footer className="welcome-footer">{t("一个目录，一部小说。")}</footer>
      </main>
      {active && <NewProjectDialog open={createDialogOpen} busy={busy} error={error} t={t} onClose={() => setCreateDialogOpen(false)}
        onPickDirectory={() => runAction(() => pickProjectDirectory(t("选择项目保存位置")))} onCreate={create} />}
    </>
  );
}
