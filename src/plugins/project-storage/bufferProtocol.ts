import type {ProjectByteView, ProjectFileData} from "@lodestory/sdk/project-storage";
import {createTaskScheduler} from "./bytes";

export function isByteView(data: ProjectFileData): data is ProjectByteView {
  return !!data && typeof data === "object" && "copyTo" in data && typeof data.copyTo === "function";
}

function copyInput(data: ProjectFileData): Uint8Array {
  if (isByteView(data)) {
    const target = new Uint8Array(data.byteLength);
    data.copyTo(target);
    return target;
  }
  const target = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
    target[i] = byte;
  }
  return target;
}

/** ASCII base64 keeps IPC payloads lossless without allocating a JS number for each byte. */
export async function encodeByteData(data: ProjectFileData): Promise<string> {
  // Capture before yielding; the pending save must not observe later caller edits.
  const bytes = copyInput(data);
  const native = (bytes as Uint8Array & {toBase64?: () => string}).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  const scheduler = createTaskScheduler();
  try {
    let i = 0, j = 0;
    while (i < bytes.length) {
      const end = Math.min(bytes.length, i + 3 * 16_384);
      for (; i < end; i += 3) {
        const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
        output[j++] = alphabet.charCodeAt(a >>> 2);
        output[j++] = alphabet.charCodeAt(((a & 3) << 4) | (b >>> 4));
        output[j++] = i + 1 < bytes.length ? alphabet.charCodeAt(((b & 15) << 2) | (c >>> 6)) : 61;
        output[j++] = i + 2 < bytes.length ? alphabet.charCodeAt(c & 63) : 61;
      }
      if (i < bytes.length) await scheduler.yieldTask();
    }
    return new TextDecoder("utf-8", {fatal: true}).decode(output);
  } finally { scheduler.close(); }
}

export async function decodeByteData(encoded: string, expectedLength: number): Promise<Uint8Array> {
  if (typeof encoded !== "string" || !Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw new Error("项目文件返回了无效内容。");
  }
  const native = (Uint8Array as Uint8ArrayConstructor & {fromBase64?: (input: string) => Uint8Array}).fromBase64;
  let bytes: Uint8Array;
  if (typeof native === "function") bytes = native.call(Uint8Array, encoded);
  else {
    const decoded = atob(encoded);
    bytes = new Uint8Array(decoded.length);
    const scheduler = createTaskScheduler();
    try {
      for (let from = 0; from < decoded.length; from += 65_536) {
        const to = Math.min(decoded.length, from + 65_536);
        for (let i = from; i < to; i++) bytes[i] = decoded.charCodeAt(i);
        if (to < decoded.length) await scheduler.yieldTask();
      }
    } finally { scheduler.close(); }
  }
  if (bytes.length !== expectedLength) throw new Error("项目文件字节长度不一致。");
  return bytes;
}
