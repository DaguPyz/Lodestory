import {PluginStopCancelledError, type Plugin} from "@lodestory/sdk";
import {createAppRuntime, type AppRuntime} from "./createAppRuntime";
import {installDesktopClose} from "./desktopClose";

type CloseErrorActions = {retry?: () => void; finish?: () => void};

/** 先接管窗口关闭，再启动运行实例；启动期间的关闭请求等待启动完成。 */
export async function startApplication(
  plugins: readonly Plugin[],
  showCloseError: (error: unknown, actions: CloseErrorActions) => () => void,
): Promise<AppRuntime> {
  let resolveStart!: (runtime: AppRuntime) => void;
  let rejectStart!: (reason: unknown) => void;
  const starting = new Promise<AppRuntime>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  // 即使启动期间没有关闭请求，也必须消费启动失败。
  void starting.catch(() => {});
  const removeClose = await installDesktopClose({
    stop: () => starting.then(runtime => runtime.stop(), () => { throw new PluginStopCancelledError(); }),
  }, showCloseError);
  try {
    const runtime = await createAppRuntime(plugins);
    resolveStart(runtime);
    return runtime;
  } catch (error) {
    rejectStart(error);
    removeClose();
    throw error;
  }
}
