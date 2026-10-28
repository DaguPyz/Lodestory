import {invoke, isTauri, type InvokeArgs} from "@tauri-apps/api/core";
import type {ProjectDirectoryListing, ProjectFileData, ProjectFileAccessOptions, ProjectFileCreateOptions} from "@lodestory/sdk/project-storage";
import {decodeByteData, encodeByteData, isByteView} from "./bufferProtocol";
import {encodeBinarySave} from "./binarySaveProtocol";

export type FileRecord = {path: string; fileName: string; bytes: ProjectFileData};
type EncodedRecord = {path: string; fileName: string; bytesBase64: string; byteLength: number};
async function decodeRecord(record: EncodedRecord): Promise<FileRecord> {
  if (!record || typeof record.path !== "string" || typeof record.fileName !== "string") {
    throw new Error("项目文件返回了无效内容。");
  }
  return {path: record.path, fileName: record.fileName, bytes: await decodeByteData(record.bytesBase64, record.byteLength)};
}
function desktopCommand<T>(command: string, args: InvokeArgs): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中操作项目文件。"));
  return invoke<T>(command, args);
}
export function readFile(projectPath: string, path: string, options?: ProjectFileAccessOptions): Promise<FileRecord> {
  if (options?.preferByteView) return desktopCommand<EncodedRecord>("read_project_file_base64", {projectPath, path}).then(decodeRecord);
  return desktopCommand("read_project_file", {projectPath, path});
}
export async function createFile(projectPath: string, path: string, bytes: ProjectFileData, options: ProjectFileCreateOptions): Promise<FileRecord> {
  if (options.preferByteView || isByteView(bytes) || !Array.isArray(bytes)) {
    const bytesBase64 = await encodeByteData(bytes);
    return decodeRecord(await desktopCommand<EncodedRecord>("create_project_file_base64", {projectPath, path, bytesBase64,
      createParents: options.createParents ?? false, acceptIdentical: options.acceptIdentical ?? false}));
  }
  return desktopCommand("create_project_file", {projectPath, path, bytes, createParents: options.createParents ?? false, acceptIdentical: options.acceptIdentical ?? false});
}
export async function saveFile(projectPath: string, path: string, bytes: ProjectFileData, expectedBytes: ProjectFileData): Promise<void> {
  if (isByteView(bytes) || isByteView(expectedBytes) || !Array.isArray(bytes) || !Array.isArray(expectedBytes)) {
    return desktopCommand("save_project_file_binary", encodeBinarySave(projectPath, path, bytes, expectedBytes));
  }
  return desktopCommand("save_project_file", {projectPath, path, bytes, expectedBytes});
}
export async function deleteFile(projectPath: string, path: string, expectedBytes: ProjectFileData): Promise<void> {
  if (isByteView(expectedBytes) || !Array.isArray(expectedBytes)) {
    const expectedBytesBase64 = await encodeByteData(expectedBytes);
    return desktopCommand("delete_project_file_base64", {projectPath, path, expectedBytesBase64});
  }
  return desktopCommand("delete_project_file", {projectPath, path, expectedBytes});
}
export function listDirectory(projectPath: string, path: string): Promise<ProjectDirectoryListing> {
  return desktopCommand("list_project_directory", {projectPath, path});
}
export function createDirectory(projectPath: string, path: string, recursive: boolean): Promise<void> {
  return desktopCommand("create_project_directory", {projectPath, path, recursive});
}
export function renamePath(projectPath: string, fromPath: string, toPath: string): Promise<void> {
  return desktopCommand("rename_project_path", {projectPath, fromPath, toPath});
}
export function storageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "项目文件操作失败，请重试。";
}
