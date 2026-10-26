import type {ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";

// Only arrays copied, validated and frozen here may be reused. External frozen inputs still need isolation.
const ownedBytes = new WeakSet<ProjectFileBytes>();
const ASYNC_COPY_THRESHOLD = 64 * 1024;
const MAX_ASYNC_COPY_CHUNK = 2048;
const ASYNC_COPY_BUDGET_MS = 3.5;
const ASYNC_COPY_CLOCK_CHECK_INTERVAL = 32;

/** Internal scheduler seam for deterministic byte-copy tests; not part of the SDK. */
export type ByteCopyTaskScheduler = Readonly<{
  now(): number;
  yieldTask(): Promise<void>;
  close(): void;
}>;

export type CopyBytesAsyncOptions = Readonly<{
  schedulerFactory?: () => ByteCopyTaskScheduler;
}>;

function createTaskScheduler(): ByteCopyTaskScheduler {
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
  if (!Array.isArray(data) && Object.prototype.toString.call(data) !== "[object Uint8Array]") throw new Error("文件内容必须是字节数组。");
  const bytes = Array.from(data);
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
  if (!Array.isArray(data) && Object.prototype.toString.call(data) !== "[object Uint8Array]") {
    throw new Error("文件内容必须是字节数组。");
  }

  // Capture the input synchronously, before the first task yield, including Array.from iterator semantics.
  const captured = Array.from(data);
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
        Object.defineProperty(bytes, index, {
          value: byte,
          writable: false,
          configurable: false,
          enumerable: true,
        });
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
