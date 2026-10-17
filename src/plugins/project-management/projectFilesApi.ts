import {invoke, isTauri} from "@tauri-apps/api/core";
import type {ProjectTreeEntry} from "./projectManagementModel";

/** 文件树的目录记录属于工程管理插件，不属于文档工作区协议。 */
export function listDocuments(projectPath: string): Promise<readonly ProjectTreeEntry[]> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作作品文档。"));
  return invoke<ProjectTreeEntry[]>("list_documents", {projectPath});
}

export function projectFilesErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "文档操作失败，请重试。";
}
