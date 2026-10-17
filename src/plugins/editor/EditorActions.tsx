import {useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {UiService} from "@lodestory/sdk/ui";
import {appPages} from "../../app/pages";
import {EditorToolbar} from "./EditorToolbar";

/** 项目级入口只消费工作台和页面服务，不读取正文插件的模型或文档。 */
export function EditorActions({workbench, ui, active}: {
  workbench: WorkbenchService;
  ui: UiService;
  active: boolean;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  if (!state.session) return null;
  const sessionId = state.session.id;
  const canInteract = () => {
    const current = workbench.getSnapshot();
    return active && current.active && !current.busy && current.session?.id === sessionId;
  };
  return <EditorToolbar active={active && state.active && !state.busy} projectName={state.session.project.name}
    onBack={() => { if (canInteract()) void workbench.closeProject().catch(error => console.error("Could not close project.", {error})); }}
    onOpenSettings={() => { if (canInteract()) void ui.openPage(appPages.settings).catch(error => console.error("Could not open settings.", {error})); }}/>;
}
