import { invoke, isTauri } from "@tauri-apps/api/core";

export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
};

export type RecentProject = ProjectRecord & { available: boolean };
export type OpenedProject = { project: ProjectRecord; projects: RecentProject[] };

function desktopCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作项目目录。"));
  return invoke<T>(command, args);
}

export function listRecentProjects(): Promise<RecentProject[]> {
  return isTauri() ? desktopCommand("list_recent_projects") : Promise.resolve([]);
}

export function openProject(path: string): Promise<OpenedProject> {
  return desktopCommand("open_project", { path });
}

export function createProject(parentPath: string, name: string): Promise<OpenedProject> {
  return desktopCommand("create_project", { parentPath, name });
}

export function relocateProject(id: string, path: string): Promise<OpenedProject> {
  return desktopCommand("relocate_project", { id, path });
}

export function removeRecentProject(id: string): Promise<RecentProject[]> {
  return desktopCommand("remove_recent_project", { id });
}

export function pickProjectDirectory(title: string): Promise<string | null> {
  return desktopCommand("pick_project_directory", { title });
}

export function projectErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return typeof error === "string" ? error : "项目操作失败，请重试。";
}

export function isUnavailableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "project_unavailable";
}
