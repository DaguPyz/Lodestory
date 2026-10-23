import {useEffect, useSyncExternalStore} from "react";
import {isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {bodyEditorContentIds} from "@lodestory/sdk/body-editor";
import {documentCreateRequested, documentsKey, type DocumentWorkspace, type DocumentsService} from "@lodestory/sdk/documents";
import {layoutKey, type LayoutContent, type LayoutService} from "@lodestory/sdk/layout";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {useContextMenus} from "../context-menu";
import {DocumentTabs} from "./DocumentTabs";
import "./document-tabs.css";

const contentId = "document-tabs.tabs";

/** Open-document navigation and actions; document state remains owned by the documents service. */
export function createDocumentTabsPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  return {
    id: "document-tabs",
    requires: [workbenchKey, documentsKey, layoutKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const content: LayoutContent = {
        id: contentId,
        title: "文稿标签",
        role: "tabs",
        render: ({active}) => <DocumentTabsContent
          active={active}
          workbench={workbench}
          documents={documents}
          layout={layout}
          requestCreate={sessionId => context.emit(documentCreateRequested, {sessionId})}
        />,
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

function DocumentTabsContent({active, workbench, documents, layout, requestCreate}: {
  active: boolean;
  workbench: WorkbenchService;
  documents: DocumentsService;
  layout: LayoutService;
  requestCreate(sessionId: string): Promise<void>;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const workspace = session ? documents.getWorkspace(session.id) : null;
  return session && workspace
    ? <DocumentTabsSession key={session.id} sessionId={session.id} active={active} workbench={workbench}
        workspace={workspace} layout={layout} requestCreate={requestCreate}/>
    : null;
}

function DocumentTabsSession({sessionId, active, workbench, workspace, layout, requestCreate}: {
  sessionId: string;
  active: boolean;
  workbench: WorkbenchService;
  workspace: DocumentWorkspace;
  layout: LayoutService;
  requestCreate(sessionId: string): Promise<void>;
}) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const workbenchState = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const layoutSnapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const menus = useContextMenus();
  const bodyVisible = layoutSnapshot.shownIds.includes(bodyEditorContentIds.main);
  const currentSession = workbenchState.session?.id === sessionId;
  const interactive = bodyVisible && active && currentSession && workbenchState.active && !workbenchState.busy && !snapshot.blocked;
  const disabled = !interactive;
  const newDisabled = disabled || !isTauri() || snapshot.creating;

  useEffect(() => {
    menus.closeAll();
  }, [interactive, menus]);

  function createDocument() {
    const current = workbench.getSnapshot();
    const currentWorkspace = workspace.getSnapshot();
    if (!isTauri() || !layout.getSnapshot().shownIds.includes(bodyEditorContentIds.main)
      || !active || current.session?.id !== sessionId || !current.active || current.busy
      || currentWorkspace.blocked || currentWorkspace.creating) return;
    void requestCreate(sessionId).catch(error => console.error("Could not request document creation.", {error}));
  }

  return bodyVisible && snapshot.documents.length > 0 ? <DocumentTabs documents={snapshot.documents} activeDocument={snapshot.activeId}
    onSelect={workspace.select} onClose={workspace.close} onCloseMany={workspace.closeMany} onSave={workspace.save}
    onNewDocument={createDocument} newDisabled={newDisabled} disabled={disabled}/> : null;
}
