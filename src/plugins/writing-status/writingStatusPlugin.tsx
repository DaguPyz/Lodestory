import {useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {documentsKey, type DocumentWorkspace, type DocumentsService} from "@lodestory/sdk/documents";
import {layoutKey, type LayoutContent} from "@lodestory/sdk/layout";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {EditorStatusBar} from "./EditorStatusBar";
import "./writing-status.css";

const contentId = "writing-status.status";

/** Writing status reads the current document directly from the documents workspace. */
export function createWritingStatusPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "writing-status",
    requires: [workbenchKey, documentsKey, layoutKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const content: LayoutContent = {
        id: contentId,
        title: "写作状态",
        role: "status",
        render: () => <WritingStatusContent workbench={workbench} documents={documents}/>,
      };
      removeContent = layout.registerContent(content);
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}

function WritingStatusContent({workbench, documents}: {
  workbench: WorkbenchService;
  documents: DocumentsService;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const workspace = session ? documents.getWorkspace(session.id) : null;
  return session && workspace
    ? <WritingStatusWorkspace key={session.id} workspace={workspace}/>
    : <EditorStatusBar document={undefined}/>;
}

function WritingStatusWorkspace({workspace}: {workspace: DocumentWorkspace}) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const document = snapshot.documents.find(item => item.id === snapshot.activeId);
  return <EditorStatusBar document={document}/>;
}
