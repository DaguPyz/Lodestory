import {invoke, isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {nativeLibraryLoaderKey, type NativeLibraryInstance, type NativeLibraryLoader, type NativeLibraryRequest, type NativeLibraryResponse} from "@lodestory/sdk/native-library-loader";
import {NativeBackendInitializationError, type JsonValue} from "@lodestory/sdk/native-process-loader";

/** 宿主提供通用动态库 ABI 和后台线程；本插件负责请求、实例及停用流程。 */
export type LibraryBridge = {
  open(entry: string): Promise<string>;
  ready(id: string): Promise<void>;
  call(id: string, request: string): Promise<string>;
  close(id: string): Promise<void>;
};

const desktopBridge: LibraryBridge = {
  open(entry) {
    if (!isTauri()) return Promise.reject(new Error("动态库后端只能在桌面应用中加载。"));
    return invoke("native_library_open", {entry});
  },
  ready(id) {return invoke("native_library_ready", {id});},
  call(id, request) {return invoke("native_library_call", {id, requestData: request});},
  close(id) {return invoke("native_library_close", {id});},
};

const TIMEOUT_MS = 30_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : "动态库调用失败。");
}
function timeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    work.then(value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);});
  });
}
function readResponse(text: string, requestId: string): NativeLibraryResponse {
  let value: unknown;
  try {value = JSON.parse(text);} catch {throw new Error("动态库返回了无效的 JSON 消息。");}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("动态库响应格式无效。");
  const response = value as Record<string, unknown>;
  if (response.type !== "response" || response.requestId !== requestId) throw new Error("动态库响应与请求不匹配。");
  if (response.status === "success" && Object.prototype.hasOwnProperty.call(response, "result")) {
    return {requestId, status: "success", result: response.result as JsonValue};
  }
  const error = response.error;
  if (response.status === "error" && error && typeof error === "object" && !Array.isArray(error)) {
    const fields = error as Record<string, unknown>;
    if (typeof fields.code === "string" && fields.code && typeof fields.message === "string") {
      return {requestId, status: "error", error: {code: fields.code, message: fields.message}};
    }
  }
  throw new Error("动态库响应格式无效。");
}

function createInstance(bridge: LibraryBridge, id: string, onClosed: (instance: NativeLibraryInstance) => void): NativeLibraryInstance {
  const pending = new Map<string, Promise<NativeLibraryResponse>>();
  let state: "running" | "closing" | "failed-close" | "closed" = "running";
  let closeWork: Promise<void> | undefined;
  const instance: NativeLibraryInstance = {
    call(request: NativeLibraryRequest) {
      if (state !== "running") return Promise.reject(new Error("动态库已停止或正在退出。"));
      if (!request.requestId?.trim() || !request.operation?.trim() || !request.schemaVersion?.trim()) {
        return Promise.reject(new Error("请求 ID、操作名和 schema 版本不能为空。"));
      }
      const requestId = request.requestId;
      if (pending.has(requestId)) return Promise.reject(new Error("请求 ID 正在使用中。"));
      let payload: string;
      try {payload = JSON.stringify({type: "call", requestId, operation: request.operation, schemaVersion: request.schemaVersion, params: request.params});}
      catch (error) {return Promise.reject(asError(error));}
      const work = Promise.resolve().then(() => bridge.call(id, payload))
        .then(result => readResponse(result, requestId));
      pending.set(requestId, work);
      void work.finally(() => {if (pending.get(requestId) === work) pending.delete(requestId);}).catch(() => {});
      return work;
    },
    close() {
      if (state === "closed") return Promise.resolve();
      if (!closeWork) {
        state = "closing";
        const work = (async () => {
          await Promise.allSettled([...pending.values()]);
          await bridge.close(id);
          state = "closed";
          onClosed(instance);
        })();
        closeWork = work;
        void work.catch(() => {
          if (closeWork === work) {closeWork = undefined; state = "failed-close";}
        });
      }
      return timeout(closeWork, "等待动态库退出超过 30 秒，请处理未完成的工作后重试。");
    },
  };
  return instance;
}

export function createNativeLibraryLoaderPlugin(bridge: LibraryBridge = desktopBridge): Plugin {
  let active = false;
  let stopping = false;
  const instances = new Set<NativeLibraryInstance>();
  const opening = new Set<Promise<unknown>>();
  async function stop() {
    stopping = true;
    await timeout(Promise.allSettled([...opening]), "等待动态库加载结束超过 30 秒。");
    const results = await Promise.allSettled([...instances].map(instance => instance.close()));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return {
    id: "native-library-loader", requires: [], provides: [nativeLibraryLoaderKey],
    activate(context) {
      active = true;
      stopping = false;
      const loader: NativeLibraryLoader = {
        load(entry) {
          if (!active || stopping) return Promise.reject(new Error("动态库加载服务已停止或正在停止。"));
          if (!entry.trim()) return Promise.reject(new Error("动态库路径不能为空。"));
          const work = (async () => {
            const id = await bridge.open(entry);
            const instance = createInstance(bridge, id, value => instances.delete(value));
            // 即使初始化或其清理失败，也要保留实例以便停止时重试。
            instances.add(instance);
            try {
              await timeout(bridge.ready(id), "等待动态库初始化超过 30 秒。");
              if (stopping || !active) throw new Error("动态库加载服务已停止或正在停止。");
              return instance;
            } catch (error) {
              try {await instance.close();}
              catch (cleanup) {throw new NativeBackendInitializationError(error, cleanup);}
              throw asError(error);
            }
          })();
          opening.add(work);
          void work.finally(() => opening.delete(work)).catch(() => {});
          return work;
        },
      };
      context.onStop({withdraw: stop});
      context.provide(nativeLibraryLoaderKey, Object.freeze(loader));
    },
    async deactivate() {
      try {await stop();} finally {active = false;}
    },
  };
}
