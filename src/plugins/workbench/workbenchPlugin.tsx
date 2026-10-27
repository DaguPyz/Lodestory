import type {Plugin} from "@lodestory/sdk";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {uiKey} from "@lodestory/sdk/ui";
import {layoutKey} from "@lodestory/sdk/layout";
import {themeKey} from "@lodestory/sdk/theme";
import {errorUiKey} from "@lodestory/sdk/error";
import {windowShellKey} from "@lodestory/sdk/window-shell";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {flushSync} from "react-dom";
import {appPages} from "../../app/pages";
import "../../styles.css";
import {WorkbenchPage} from "./WorkbenchPage";
import {createWorkbenchStore} from "./workbenchStore";

/** 编辑页面的项目协调器；不导入文档、文件树或正文编辑实现。 */
export function createWorkbenchPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    id: "workbench",
    requires: [uiKey, layoutKey, themeKey, errorUiKey, windowShellKey],
    provides: [workbenchKey],
    activate(context) {
      const ui = context.get(uiKey);
      const layout = context.get(layoutKey);
      const WindowShell = context.get(windowShellKey).View;
      const {ErrorBoundary} = context.get(errorUiKey);
      let removePage: (() => void) | undefined;
      let removeGuard: (() => void) | undefined;
      let removeWrapper: (() => void) | undefined;
      let removeCloseListener: (() => void) | undefined;
      let alive = true;
      const store = createWorkbenchStore(ui, {
        editorPage: appPages.editor, welcomePage: appPages.welcome,
        stopView: () => flushSync(() => removePage?.()),
        flushView: update => flushSync(update),
      });
      cleanup = async () => {
        alive = false;
        const errors: unknown[] = [];
        for (const remove of [removeCloseListener, removePage, removeGuard, removeWrapper]) {
          try { remove?.(); } catch (error) { errors.push(error); }
        }
        try { await store.dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new Error("Workbench failed to stop."), {errors});
      };
      context.provide(workbenchKey, store.service);
      removeGuard = ui.registerNavigationGuard({id: "workbench", prepare: store.prepareNavigation});
      removePage = ui.registerPage({
        id: appPages.editor,
        render: ({active}) => <ErrorBoundary><WindowShell showBrowserTitlebar={false}>
          <WorkbenchPage workbench={store.service} layout={layout} active={active}/>
        </WindowShell></ErrorBoundary>,
      });
      removeWrapper = ui.addWrapper({
        id: "workbench", order: 40, wrap: children => children,
        async prepare() {
          store.start();
          if (!isTauri()) return;
          const stop = await getCurrentWindow().onCloseRequested(async event => {
            try { if (!alive || !await store.shutdown()) event.preventDefault(); }
            catch (error) {
              // 保存检查失败仍保留窗口；会话已提交关闭后的清理错误仅报告，避免留下已卸载的空窗口。
              if (!alive || store.service.getSnapshot().session) event.preventDefault();
              console.error("Workbench could not close the application.", {error});
            }
          });
          if (alive) removeCloseListener = stop;
          else stop();
        },
      });
    },
    async deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      await stop?.();
    },
  };
}
