import {useSyncExternalStore} from "react";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService} from "@lodestory/sdk/workbench";

/** 工作台只持有公共项目身份；功能组件和资源由各参与者提供。 */
export function WorkbenchPage({workbench, layout, active}: {
  workbench: WorkbenchService;
  layout: LayoutService;
  active: boolean;
}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const View = layout.View;
  return snapshot.session ? <View key={snapshot.session.id} active={active && !snapshot.busy}/> : null;
}
