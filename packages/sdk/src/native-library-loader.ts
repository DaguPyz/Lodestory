import {createServiceKey} from "./ServiceKey.js";
import type {NativeProcessRequest, NativeProcessResponse} from "./native-process-loader.js";

/** 动态库与独立程序使用相同的调用数据格式，不共享加载实现。 */
export type NativeLibraryRequest = NativeProcessRequest;
export type NativeLibraryResponse = NativeProcessResponse;
export type NativeLibraryInstance = {
  call(request: NativeLibraryRequest): Promise<NativeLibraryResponse>;
  /** 等待调用、插件清理及库句柄释放；失败时保留可追踪的状态。 */
  close(): Promise<void>;
};
export type NativeLibraryLoader = {
  /** 加载可信的本地动态库；该能力不提供沙箱或插件包发现。 */
  load(entry: string): Promise<NativeLibraryInstance>;
};
export const nativeLibraryLoaderKey = createServiceKey<NativeLibraryLoader>("app/native-library-loader");
