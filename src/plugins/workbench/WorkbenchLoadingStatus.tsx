import {useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";

/** A status contribution owned by the same workbench that owns project startup. */
export function WorkbenchLoadingStatus({workbench}: {workbench: WorkbenchService}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const loading = snapshot.loading;
  if (!snapshot.session || !loading || loading.error) return null;
  const label = loading.current ? `正在加载${loading.current}…` : "正在加载项目…";
  return <div className="workbench-status-loading" title={`${label} 已完成 ${loading.completed}/${loading.total} 项`}>
    <span className="workbench-status-task">{label}</span>
    <progress className="workbench-loading-progress" aria-label="工作台加载进度"
      max={Math.max(1, loading.total)} value={loading.completed}/>
    <span className="workbench-status-count">{loading.completed}/{loading.total}</span>
  </div>;
}
