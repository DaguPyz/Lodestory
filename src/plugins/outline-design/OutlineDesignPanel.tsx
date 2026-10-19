import {useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";

export function OutlineDesignPanel({workbench}: {workbench: WorkbenchService}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const project = snapshot.session?.project;

  return <div className="outline-design-panel">
    <p className="outline-design-description">规划故事总纲、分卷与章节。</p>
    {project
      ? <div className="outline-design-project">
          <span className="outline-design-project-label">当前项目</span>
          <strong className="outline-design-project-name" title={project.name}>{project.name}</strong>
        </div>
      : <p className="outline-design-empty" role="status">请先打开一个项目。</p>}
  </div>;
}
