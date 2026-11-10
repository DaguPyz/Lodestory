import {invoke, isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {nativeProcessLoaderKey, type JsonValue, type NativeProcessInstance, type NativeProcessLoader, type NativeProcessRequest, type NativeProcessResponse} from "@lodestory/sdk/native-process-loader";

/** 宿主只提供通用进程输入输出；消息协议由本插件处理。 */
export type ProcessBridge = {
  start(entry: string): Promise<string>;
  read(id: string): Promise<string | null>;
  write(id: string, line: string): Promise<void>;
  wait(id: string): Promise<number>;
  abortStart(id: string): Promise<void>;
};

const desktopBridge: ProcessBridge = {
  start(entry) {
    if (!isTauri()) return Promise.reject(new Error("独立程序后端只能在桌面应用中启动。"));
    return invoke("native_process_start", {entry});
  },
  read(id) { return invoke("native_process_read", {id}); },
  write(id, line) { return invoke("native_process_write", {id, line}); },
  wait(id) { return invoke("native_process_wait", {id}); },
  abortStart(id) { return invoke("native_process_abort_start", {id}); },
};

type Pending = {promise: Promise<NativeProcessResponse>; resolve(value: NativeProcessResponse): void; reject(reason: Error): void};
const TIMEOUT_MS = 30_000;

/** 后端明确拒绝退出，仍可处理下一次退出请求。 */
class ShutdownRejectedError extends Error {}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : "后端通信失败。");
}

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function parse(line: string | null): Record<string, unknown> {
  if (line === null) throw new Error("后端程序的输出已关闭。");
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("后端返回了无效的 JSON 消息。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("后端消息格式无效。");
  return value as Record<string, unknown>;
}

function readResponse(value: Record<string, unknown>): NativeProcessResponse {
  if (value.type !== "response" || typeof value.requestId !== "string" || !value.requestId) throw new Error("后端响应格式无效。");
  if (value.status === "success" && Object.prototype.hasOwnProperty.call(value, "result")) return {requestId: value.requestId, status: "success", result: value.result as JsonValue};
  const error = value.error;
  if (value.status === "error" && error && typeof error === "object" && !Array.isArray(error)) {
    const fields = error as Record<string, unknown>;
    if (typeof fields.code === "string" && fields.code && typeof fields.message === "string") {
      return {requestId: value.requestId, status: "error", error: {code: fields.code, message: fields.message}};
    }
  }
  throw new Error("后端响应格式无效。");
}

async function openInstance(bridge: ProcessBridge, entry: string, onClosed: (instance: NativeProcessInstance) => void): Promise<NativeProcessInstance> {
  const id = await bridge.start(entry);
  try {
    const ready = parse(await timeout(bridge.read(id), "等待后端准备超过 30 秒。"));
    if (ready.type !== "ready" || ready.protocolVersion !== "1.0.0") throw new Error("后端准备消息或协议版本无效。");
  } catch (error) {
    try { await bridge.abortStart(id); } catch (cleanup) { throw new Error(`后端启动失败，清理未完成：${asError(cleanup).message}`); }
    throw asError(error);
  }

  const pending = new Map<string, Pending>();
  let state: "running" | "closing" | "closed" | "failed" = "running";
  let failure: Error | undefined;
  let closeWork: Promise<void> | undefined;
  let shutdownId: string | undefined;
  let sequence = 0;
  function fail(error: unknown) {
    if (state === "closed" || state === "failed") return;
    state = "failed";
    failure = asError(error);
    for (const item of pending.values()) item.reject(failure);
    pending.clear();
    // 即使程序异常退出也要回收进程；若仍在运行，不强制结束。
    void bridge.wait(id).catch(() => {});
  }
  function send(requestId: string, data: Record<string, unknown>): Promise<NativeProcessResponse> {
    if (pending.has(requestId)) return Promise.reject(new Error("请求 ID 正在使用中。"));
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const promise = new Promise<NativeProcessResponse>((ok, no) => { resolve = ok; reject = no; });
    pending.set(requestId, {promise, resolve, reject});
    let line: string;
    try { line = JSON.stringify(data); } catch (error) { pending.delete(requestId); reject(asError(error)); return promise; }
    void Promise.resolve().then(() => bridge.write(id, line)).catch(fail);
    return promise;
  }
  async function readLoop() {
    try {
      while (state !== "closed" && state !== "failed") {
        const response = readResponse(parse(await bridge.read(id)));
        const item = pending.get(response.requestId);
        if (!item) throw new Error("后端返回了未知请求的响应。");
        pending.delete(response.requestId);
        item.resolve(response);
        // 退出响应后，剩余工作是等待进程结束，不再读取输出。
        if (response.requestId === shutdownId && response.status === "success") return;
      }
    } catch (error) { fail(error); }
  }
  void readLoop();
  const instance: NativeProcessInstance = {
    call(request: NativeProcessRequest) {
      if (state !== "running") return Promise.reject(failure ?? new Error("后端已停止或正在退出。"));
      if (!request.requestId?.trim() || !request.operation?.trim() || !request.schemaVersion?.trim()) return Promise.reject(new Error("请求 ID、操作名和 schema 版本不能为空。"));
      return send(request.requestId, {type: "call", requestId: request.requestId, operation: request.operation, schemaVersion: request.schemaVersion, params: request.params});
    },
    close() {
      if (state === "closed") return Promise.resolve();
      if (state === "failed") return Promise.reject(new Error(`${failure?.message ?? "后端退出失败。"} 无法确认后端已完成清理。`));
      if (!closeWork) {
        state = "closing";
        closeWork = (async () => {
          await Promise.allSettled([...pending.values()].map(item => item.promise));
          if (failure) throw failure;
          shutdownId = `shutdown-${++sequence}`;
          const response = await send(shutdownId, {type: "shutdown", requestId: shutdownId});
          if (response.status === "error") throw new ShutdownRejectedError(`后端清理失败：${response.error.message}`);
          const exitCode = await bridge.wait(id);
          if (exitCode !== 0) throw new Error("后端退出状态异常，无法确认清理已完成。");
          state = "closed";
          onClosed(instance);
        })().catch(error => {
          if (error instanceof ShutdownRejectedError && state !== "failed") {
            // 后端拒绝退出后仍保持通信，允许用户处理问题并重新请求退出。
            state = "running";
            shutdownId = undefined;
            closeWork = undefined;
          } else {
            fail(error);
          }
          throw asError(error);
        });
      }
      return timeout(closeWork, "等待后端退出超过 30 秒，请处理未完成的工作后重试。");
    },
  };
  return instance;
}

export function createNativeProcessLoaderPlugin(bridge: ProcessBridge = desktopBridge): Plugin {
  let active = false;
  let stopping = false;
  const instances = new Set<NativeProcessInstance>();
  const opening = new Set<Promise<unknown>>();
  return {
    id: "native-process-loader",
    requires: [],
    provides: [nativeProcessLoaderKey],
    activate(context) {
      active = true;
      stopping = false;
      const loader: NativeProcessLoader = {
        load(entry) {
          if (!active || stopping) return Promise.reject(new Error("独立程序加载服务已停止或正在停止。"));
          if (!entry.trim()) return Promise.reject(new Error("后端程序入口不能为空。"));
          const task = openInstance(bridge, entry, instance => instances.delete(instance)).then(instance => { instances.add(instance); return instance; });
          opening.add(task);
          void task.finally(() => opening.delete(task)).catch(() => {});
          return task;
        },
      };
      context.onStop({
        async withdraw() {
          stopping = true;
          await Promise.allSettled([...opening]);
          const results = await Promise.allSettled([...instances].map(instance => instance.close()));
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        },
      });
      context.provide(nativeProcessLoaderKey, Object.freeze(loader));
    },
    deactivate() { active = false; },
  };
}
