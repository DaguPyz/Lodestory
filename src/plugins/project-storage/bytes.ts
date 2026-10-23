import type {ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";

export function copyBytes(data: ProjectFileData): ProjectFileBytes {
  if (!Array.isArray(data) && Object.prototype.toString.call(data) !== "[object Uint8Array]") throw new Error("文件内容必须是字节数组。");
  const bytes = Array.from(data);
  if (!bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("文件字节必须是 0 到 255 的整数。");
  return Object.freeze(bytes);
}
export function equalBytes(left: ProjectFileBytes, right: ProjectFileBytes): boolean {
  return left === right || left.length === right.length && left.every((byte, index) => byte === right[index]);
}
