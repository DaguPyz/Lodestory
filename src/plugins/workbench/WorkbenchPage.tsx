import {useState, useSyncExternalStore} from "react";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import {Button} from "@lodestory/ui";
import "./workbench.css";

/** 工作台只持有公共项目身份；功能组件和资源由各参与者提供。 */
export function WorkbenchPage({workbench, layout, active}: {
  workbench: WorkbenchService;
  layout: LayoutService;
  active: boolean;
}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const [recoveryAction, setRecoveryAction] = useState<"retry" | "return" | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const View = layout.View;
  const loading = snapshot.loading ?? null;
  if (!snapshot.session && !loading) return null;

  async function recover(action: "retry" | "return") {
    if (recoveryAction) return;
    setRecoveryAction(action);
    setRecoveryError(null);
    try {
      const completed = action === "retry"
        ? await workbench.retryProject()
        : await workbench.returnProject();
      if (!completed) setRecoveryError(action === "retry"
        ? "重试未能启动，请稍后再试。"
        : "无法返回上一个页面，请重试。",
      );
    } catch (error) {
      console.error("Could not recover the workbench project.", {action, error});
      setRecoveryError(action === "retry" ? "重试失败，请稍后再试。" : "返回失败，请重试。");
    } finally {
      setRecoveryAction(null);
    }
  }

  const failed = loading?.error ?? null;
  const busy = snapshot.busy || loading !== null;
  return <div className="workbench-page">
    {snapshot.session && <div className="workbench-page-content" inert={busy} aria-busy={busy}>
      <View key={snapshot.session.id} active={active && !busy}/>
    </div>}
    {loading && !failed && <span className="workbench-loading-announcement" role="status">
      {loading.current ? `正在加载${loading.current}…` : "正在加载项目…"} 已完成 {loading.completed}/{loading.total} 项
    </span>}
    {failed && <aside className="workbench-loading" aria-live="assertive">
        <div className="workbench-loading-copy" role="alert">
          <strong>项目加载失败</strong>
          <span>{recoveryError ?? failed.message}</span>
        </div>
        <div className="workbench-loading-actions">
          <Button variant="secondary" disabled={recoveryAction !== null} onClick={() => void recover("retry")}>
            {recoveryAction === "retry" ? "正在重试…" : "重试加载"}
          </Button>
          <Button variant="ghost" disabled={recoveryAction !== null} onClick={() => void recover("return")}>
            {recoveryAction === "return" ? "正在返回…" : "返回"}
          </Button>
        </div>
    </aside>}
  </div>;
}
