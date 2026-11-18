import {useCallback, useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {documentsKey, type DocumentWorkspace, type DocumentsService} from "@lodestory/sdk/documents";
import {bodyEditorContentIds, bodyEditorKey, type BodyEditorService} from "@lodestory/sdk/body-editor";
import {layoutKey, type LayoutContent, type LayoutService} from "@lodestory/sdk/layout";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {i18nKey, type I18nService} from "@lodestory/sdk/i18n";
import {EditorStatusBar} from "./EditorStatusBar";
import "./writing-status.css";

const contentId = "writing-status.status";

/** Writing status reads the current document directly from the documents workspace. */
export function createWritingStatusPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "writing-status",
    requires: [workbenchKey, documentsKey, layoutKey, bodyEditorKey, i18nKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const bodyEditor = context.get(bodyEditorKey);
      const i18n = context.get(i18nKey);
      const content: LayoutContent = {
        id: contentId,
        title: "写作状态",
        role: "status",
        render: () => <WritingStatusContent workbench={workbench} documents={documents} bodyEditor={bodyEditor} layout={layout} i18n={i18n}/>,
      };
      removeContent = context.track(layout.registerContent(content));
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}

function WritingStatusContent({workbench, documents, bodyEditor, layout, i18n}: {
  workbench: WorkbenchService;
  documents: DocumentsService;
  bodyEditor: BodyEditorService;
  layout: LayoutService;
  i18n: I18nService;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const layoutSnapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const showDocumentDetails = layoutSnapshot.shownIds.includes(bodyEditorContentIds.main);
  const session = state.session;
  const workspace = session ? documents.getWorkspace(session.id) : null;
  return session && workspace
    ? <WritingStatusWorkspace key={session.id} workspace={workspace} bodyEditor={bodyEditor} showDocumentDetails={showDocumentDetails} i18n={i18n}/>
    : <EditorStatusBar document={undefined} showDocumentDetails={showDocumentDetails} i18n={i18n}/>;
}

function WritingStatusWorkspace({workspace, bodyEditor, showDocumentDetails, i18n}: {
  workspace: DocumentWorkspace;
  bodyEditor: BodyEditorService;
  showDocumentDetails: boolean;
  i18n: I18nService;
}) {
  const subscribeWorkspace = useCallback((listener: () => void) => workspace.subscribe(listener), [workspace]);
  const getWorkspaceSnapshot = useCallback(() => workspace.getSnapshot(), [workspace]);
  const snapshot = useSyncExternalStore(subscribeWorkspace, getWorkspaceSnapshot, getWorkspaceSnapshot);
  const document = snapshot.documents.find(item => item.id === snapshot.activeId);
  const subscribe = useCallback((listener: () => void) => bodyEditor.subscribe(listener), [bodyEditor]);
  const getText = useCallback(() => document
    ? bodyEditor.getText(document.fileName, document.content)
    : undefined, [bodyEditor, document?.fileName, document?.content]);
  const text = useSyncExternalStore(subscribe, getText, getText);
  return <EditorStatusBar document={document} text={text} showDocumentDetails={showDocumentDetails} i18n={i18n}/>;
}
