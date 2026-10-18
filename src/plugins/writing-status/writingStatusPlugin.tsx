import {useCallback, useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {documentsKey, type DocumentWorkspace, type DocumentsService} from "@lodestory/sdk/documents";
import {bodyEditorKey, type BodyEditorService} from "@lodestory/sdk/body-editor";
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
    requires: [workbenchKey, documentsKey, layoutKey, bodyEditorKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const bodyEditor = context.get(bodyEditorKey);
      const content: LayoutContent = {
        id: contentId,
        title: "写作状态",
        role: "status",
        render: () => <WritingStatusContent workbench={workbench} documents={documents} bodyEditor={bodyEditor}/>,
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

function WritingStatusContent({workbench, documents, bodyEditor}: {
  workbench: WorkbenchService;
  documents: DocumentsService;
  bodyEditor: BodyEditorService;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const workspace = session ? documents.getWorkspace(session.id) : null;
  return session && workspace
    ? <WritingStatusWorkspace key={session.id} workspace={workspace} bodyEditor={bodyEditor}/>
    : <EditorStatusBar document={undefined}/>;
}

function WritingStatusWorkspace({workspace, bodyEditor}: {workspace: DocumentWorkspace; bodyEditor: BodyEditorService}) {
  const subscribeWorkspace = useCallback((listener: () => void) => workspace.subscribe(listener), [workspace]);
  const getWorkspaceSnapshot = useCallback(() => workspace.getSnapshot(), [workspace]);
  const snapshot = useSyncExternalStore(subscribeWorkspace, getWorkspaceSnapshot, getWorkspaceSnapshot);
  const document = snapshot.documents.find(item => item.id === snapshot.activeId);
  const subscribe = useCallback((listener: () => void) => bodyEditor.subscribe(listener), [bodyEditor]);
  const getText = useCallback(() => document
    ? bodyEditor.getText(document.fileName, document.content)
    : undefined, [bodyEditor, document?.fileName, document?.content]);
  const text = useSyncExternalStore(subscribe, getText, getText);
  return <EditorStatusBar document={document} text={text}/>;
}
