import type {ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";
import {copyProjectByteViewToArray, isProjectByteView} from "./byteView";

// Only arrays copied, validated and frozen here may be reused. External frozen inputs still need isolation.
const ownedBytes = new WeakSet<ProjectFileBytes>();
const ASYNC_COPY_THRESHOLD = 64 * 1024;
const MAX_ASYNC_COPY_CHUNK = 64 * 1024;
const ASYNC_COPY_BUDGET_MS = 3.5;
const ASYNC_COPY_CLOCK_CHECK_INTERVAL = 64;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const uint8ArrayPrototype = Uint8Array.prototype;
const typedArrayPrototype = getPrototypeOf(uint8ArrayPrototype);
const uint8ArrayIterator = Uint8Array.prototype[Symbol.iterator];
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayNameGetter = getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayLengthGetter = getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const typedArrayBufferGetter = getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const arrayBufferByteLengthGetter = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const arrayBufferResizableGetter = getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

/** Internal scheduler seam for deterministic byte-copy tests; not part of the SDK. */
export type ByteCopyTaskScheduler = Readonly<{
  now(): number;
  yieldTask(): Promise<void>;
  close(): void;
}>;

export type CopyBytesAsyncOptions = Readonly<{
  schedulerFactory?: () => ByteCopyTaskScheduler;
}>;

function captureBytes(data: ProjectFileData): number[] {
  if (isProjectByteView(data)) return copyProjectByteViewToArray(data);
  if (arrayBufferIsView(data) && typedArrayNameGetter?.call(data) === "Uint8Array"
    && getPrototypeOf(data) === uint8ArrayPrototype
    && !getOwnPropertyDescriptor(data, Symbol.iterator)
    && !getOwnPropertyDescriptor(uint8ArrayPrototype, Symbol.iterator)
    && getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator)?.value === uint8ArrayIterator
    && typedArrayLengthGetter && typedArrayBufferGetter
    && arrayBufferByteLengthGetter) {
    const buffer = typedArrayBufferGetter.call(data);
    try {
      arrayBufferByteLengthGetter.call(buffer);
    } catch {
      return Array.from(data);
    }
    if (arrayBufferResizableGetter?.call(buffer) === true) return Array.from(data);
    // Match the intrinsic iterator's detached-buffer validation before copying by index.
    uint8ArrayIterator.call(data);
    const length = typedArrayLengthGetter.call(data);
    if (typeof length === "number") {
      const bytes = new Array<number>(length);
      for (let index = 0; index < length; index++) bytes[index] = data[index];
      return bytes;
    }
  }
  return Array.from(data);
}

export function createTaskScheduler(): ByteCopyTaskScheduler {
  const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  let resolvePending: (() => void) | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let channel: MessageChannel | undefined;

  if (typeof MessageChannel !== "undefined") {
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const resolve = resolvePending;
        resolvePending = null;
        resolve?.();
      };
    } catch {
      channel = undefined;
    }
  }

  return {
    now,
    yieldTask() {
      return new Promise<void>(resolve => {
        resolvePending = resolve;
        if (channel) {
          try {
            channel.port2.postMessage(0);
            return;
          } catch {
            // A timer still gives the caller a task boundary if MessageChannel is unavailable.
          }
        }
        fallbackTimer = setTimeout(() => {
          fallbackTimer = undefined;
          const complete = resolvePending;
          resolvePending = null;
          complete?.();
        }, 0);
      });
    },
    close() {
      channel?.port1.close();
      channel?.port2.close();
      channel = undefined;
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
      const resolve = resolvePending;
      resolvePending = null;
      resolve?.();
    },
  };
}

export function copyBytes(data: ProjectFileData): ProjectFileBytes {
  if (Array.isArray(data) && ownedBytes.has(data)) return data;
  if (!Array.isArray(data) && !isProjectByteView(data) && Object.prototype.toString.call(data) !== "[object Uint8Array]") throw new Error("文件内容必须是字节数组。");
  const bytes = captureBytes(data);
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
  }
  Object.freeze(bytes);
  ownedBytes.add(bytes);
  return bytes;
}

/**
 * Copy large file data without one long freeze operation. The returned value is still a normal,
 * dense, frozen Array; small inputs retain the same synchronous validation and freeze path.
 */
export async function copyBytesAsync(data: ProjectFileData, options: CopyBytesAsyncOptions = {}): Promise<ProjectFileBytes> {
  if (Array.isArray(data) && ownedBytes.has(data)) return data;
  if (!Array.isArray(data) && !isProjectByteView(data) && Object.prototype.toString.call(data) !== "[object Uint8Array]") {
    throw new Error("文件内容必须是字节数组。");
  }

  // Capture the input synchronously, before the first task yield, including Array.from iterator semantics.
  const captured = captureBytes(data);
  if (captured.length < ASYNC_COPY_THRESHOLD) {
    for (let index = 0; index < captured.length; index++) {
      const byte = captured[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
    }
    Object.freeze(captured);
    ownedBytes.add(captured);
    return captured;
  }

  const bytes = new Array<number>(captured.length);
  // Lock length first; subsequent indexed definitions fill existing slots without growing it.
  Object.defineProperty(bytes, "length", {writable: false});
  const byteDescriptor: PropertyDescriptor = {
    value: 0,
    writable: false,
    configurable: false,
    enumerable: true,
  };
  const scheduler = options.schedulerFactory?.() ?? createTaskScheduler();
  try {
    let index = 0;
    while (index < captured.length) {
      const deadline = scheduler.now() + ASYNC_COPY_BUDGET_MS;
      let count = 0;
      while (index < captured.length && count < MAX_ASYNC_COPY_CHUNK) {
        if (count > 0 && count % ASYNC_COPY_CLOCK_CHECK_INTERVAL === 0 && scheduler.now() >= deadline) break;
        const byte = captured[index];
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("文件字节必须是 0 到 255 的整数。");
        byteDescriptor.value = byte;
        Object.defineProperty(bytes, index, byteDescriptor);
        index++;
        count++;
      }
      if (index < captured.length) await scheduler.yieldTask();
    }
    Object.preventExtensions(bytes);
    ownedBytes.add(bytes);
    return bytes;
  } finally {
    scheduler.close();
  }
}

export function equalBytes(left: ProjectFileBytes, right: ProjectFileBytes): boolean {
  return left === right || left.length === right.length && left.every((byte, index) => byte === right[index]);
}
