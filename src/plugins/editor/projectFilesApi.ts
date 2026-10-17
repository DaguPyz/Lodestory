import {invoke, isTauri} from "@tauri-apps/api/core";

/** 文件树功能的私有目录记录，不属于文档工作区协议。 */
export type TreeEntry = {path: string; name: string; children?: TreeEntry[]};

export function listDocuments(projectPath: string): Promise<TreeEntry[]> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作作品文档。"));
  return invoke<TreeEntry[]>("list_documents", {projectPath});
}

export function projectFilesErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "文档操作失败，请重试。";
}
