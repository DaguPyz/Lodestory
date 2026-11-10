import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {PluginStopCancelledError} from "@lodestory/sdk";
import {PluginBatchDeactivationError, PluginStopPreparationError} from "../plugin-core";
import type {AppRuntime} from "./createAppRuntime";

type CloseErrorActions = {retry?: () => void; finish?: () => void};
type ShowCloseError = (error: unknown, actions: CloseErrorActions) => () => void;

/** 原生窗口只触发通用停用流程；插件负责各自的保存与资源清理。 */
export async function installDesktopClose(runtime: Pick<AppRuntime, "stop">, showError: ShowCloseError): Promise<() => void> {
  if (!isTauri()) return () => {};
  const appWindow = getCurrentWindow();
  let closing = false;
  let destroying = false;
  let clearError: (() => void) | undefined;

  function display(error: unknown, actions: CloseErrorActions) {
    console.error("Application could not close.", {error});
    clearError?.();
    clearError = showError(error, actions);
  }

  async function destroyStoppedWindow() {
    if (destroying) return;
    destroying = true;
    try {
      await appWindow.destroy();
    } catch (error) {
      display(error, {finish: () => { void destroyStoppedWindow(); }});
    } finally {
      destroying = false;
    }
  }

  async function attemptStop(): Promise<boolean> {
    // 同一关闭请求尚未结束时，其他请求不能提前关闭窗口。
    if (closing) return false;
    closing = true;
    clearError?.();
    clearError = undefined;
    try {
      await runtime.stop();
      return true;
    } catch (error) {
      if (error instanceof PluginStopCancelledError
        || (error instanceof PluginStopPreparationError && error.cause instanceof PluginStopCancelledError)) return false;
      if (error instanceof PluginBatchDeactivationError) {
        // 全部插件已停用，deactivate 不能再重试；由用户确认是否关闭窗口。
        display(error, {finish: () => { void destroyStoppedWindow(); }});
      } else {
        display(error, {retry: () => { void retryClose(); }});
      }
      return false;
    } finally {
      closing = false;
    }
  }

  async function retryClose() {
    if (await attemptStop()) await destroyStoppedWindow();
  }

  return appWindow.onCloseRequested(async event => {
    // 立即拦截原生默认关闭，即使异步检查或错误提示本身失败也不提前销毁窗口。
    event.preventDefault();
    if (await attemptStop()) await destroyStoppedWindow();
  });
}
