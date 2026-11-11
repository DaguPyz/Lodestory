import {createServiceKey} from "./ServiceKey.js";

/** 后端请求及结果均使用 JSON 数据；操作及其 schema 由插件自行定义。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type NativeProcessRequest = {
  requestId: string;
  operation: string;
  schemaVersion: string;
  params: JsonValue;
};
export type NativeProcessResponse =
  | {requestId: string; status: "success"; result: JsonValue}
  | {requestId: string; status: "error"; error: {code: string; message: string}};

/** Initialization failed and the host could not confirm cleanup of the partial backend. */
export class NativeBackendInitializationError extends Error {
  constructor(readonly initializationError: unknown, readonly cleanupError: unknown) {
    super(`后端启动失败：${initializationError instanceof Error ? initializationError.message : String(initializationError)}；清理未完成：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    this.name = "NativeBackendInitializationError";
  }
}

/** 一个已准备好的独立程序后端。close 等待完成清理和进程退出。 */
export type NativeProcessInstance = {
  call(request: NativeProcessRequest): Promise<NativeProcessResponse>;
  close(): Promise<void>;
};
export type NativeProcessLoader = {
  /** 执行可信的本地程序；该能力不提供沙箱或插件包发现。 */
  load(entry: string): Promise<NativeProcessInstance>;
};
export const nativeProcessLoaderKey = createServiceKey<NativeProcessLoader>("app/native-process-loader");
