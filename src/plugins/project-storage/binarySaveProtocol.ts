import type {ProjectFileData} from "@lodestory/sdk/project-storage";
import {isByteView} from "./bufferProtocol";

const encoder = new TextEncoder();
const setBytes = Uint8Array.prototype.set;

function byteLength(data: ProjectFileData): number {
  const length = isByteView(data) ? data.byteLength : data.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("文件字节长度无效。");
  return length;
}

function copyBytes(data: ProjectFileData, target: Uint8Array, offset: number, length: number) {
  if (isByteView(data)) {
    data.copyTo(target, offset, 0, length);
  } else if (!Array.isArray(data)) {
    setBytes.call(target, data, offset);
  } else {
    for (let index = 0; index < length; index++) {
      const byte = data[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
      target[offset + index] = byte;
    }
  }
}

/** Raw IPC body: u32LE metadata size, UTF-8 metadata, new bytes, exact conflict baseline. */
export function encodeBinarySave(projectPath: string, path: string, data: ProjectFileData, expected: ProjectFileData): Uint8Array {
  if (typeof projectPath !== "string" || typeof path !== "string") throw new Error("文件路径无效。");
  const dataLength = byteLength(data), expectedLength = byteLength(expected);
  const metadata = encoder.encode(JSON.stringify({version: 1, projectPath, path, byteLength: dataLength, expectedByteLength: expectedLength}));
  const total = 4 + metadata.length + dataLength + expectedLength;
  if (metadata.length > 0xffffffff || !Number.isSafeInteger(total)) throw new Error("文件字节长度无效。");
  // Capture both payloads synchronously before invoke yields. Neither caller memory nor
  // a mutable view of the canonical buffer is passed to the native bridge.
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, metadata.length, true);
  setBytes.call(body, metadata, 4);
  const offset = 4 + metadata.length;
  copyBytes(data, body, offset, dataLength);
  copyBytes(expected, body, offset + dataLength, expectedLength);
  return body;
}
