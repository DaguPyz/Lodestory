import { invoke, isTauri } from "@tauri-apps/api/core";

export type DocumentRecord = { path: string; fileName: string; content: string };

function desktopCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作作品文档。"));
  return invoke<T>(command, args);
}

export function createDocument(projectPath: string, parentPath: string, name: string, content = ""): Promise<DocumentRecord> {
  return desktopCommand("create_document", { projectPath, parentPath, name, content });
}

export function createDocumentDirectory(projectPath: string, parentPath: string, name: string): Promise<string> {
  return desktopCommand("create_document_directory", { projectPath, parentPath, name });
}

export function deleteDocument(projectPath: string, path: string, expectedContent: string): Promise<void> {
  return desktopCommand("delete_document", { projectPath, path, expectedContent });
}

export function readDocument(projectPath: string, path: string): Promise<DocumentRecord> {
  return desktopCommand("read_document", { projectPath, path });
}

export function saveDocument(projectPath: string, path: string, content: string, expectedContent: string): Promise<void> {
  return desktopCommand("save_document", { projectPath, path, content, expectedContent });
}

export function documentErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "文档操作失败，请重试。";
}
