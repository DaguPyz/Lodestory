import {invoke, isTauri} from "@tauri-apps/api/core";
import type {ProjectDirectoryListing, ProjectFileBytes, ProjectFileCreateOptions} from "@lodestory/sdk/project-storage";

export type FileRecord = {path: string; fileName: string; bytes: ProjectFileBytes};
function desktopCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作项目文件。"));
  return invoke<T>(command, args);
}
export function readFile(projectPath: string, path: string): Promise<FileRecord> {
  return desktopCommand("read_project_file", {projectPath, path});
}
export function createFile(projectPath: string, path: string, bytes: ProjectFileBytes, options: ProjectFileCreateOptions): Promise<FileRecord> {
  return desktopCommand("create_project_file", {projectPath, path, bytes, createParents: options.createParents ?? false, acceptIdentical: options.acceptIdentical ?? false});
}
export function saveFile(projectPath: string, path: string, bytes: ProjectFileBytes, expectedBytes: ProjectFileBytes): Promise<void> {
  return desktopCommand("save_project_file", {projectPath, path, bytes, expectedBytes});
}
export function deleteFile(projectPath: string, path: string, expectedBytes: ProjectFileBytes): Promise<void> {
  return desktopCommand("delete_project_file", {projectPath, path, expectedBytes});
}
export function listDirectory(projectPath: string, path: string): Promise<ProjectDirectoryListing> {
  return desktopCommand("list_project_directory", {projectPath, path});
}
export function createDirectory(projectPath: string, path: string, recursive: boolean): Promise<void> {
  return desktopCommand("create_project_directory", {projectPath, path, recursive});
}
export function storageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "项目文件操作失败，请重试。";
}
