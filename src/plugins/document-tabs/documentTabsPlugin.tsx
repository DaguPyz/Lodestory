import {i18nKey, type I18nService} from "@lodestory/sdk/i18n";
import type {Translate} from "@lodestory/sdk/i18n";
import {useTranslation} from "../../utils/useTranslation";
import {useEffect, useSyncExternalStore} from "react";
import {isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {bodyEditorContentIds} from "@lodestory/sdk/body-editor";
import {documentsKey, type DocumentWorkspace, type DocumentsService} from "@lodestory/sdk/documents";
import {layoutKey, type LayoutContent, type LayoutService} from "@lodestory/sdk/layout";
import {shortcutsKey, shortcutCommandIds, shortcutScopeIds, type ShortcutsService} from "@lodestory/sdk/shortcuts";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {useContextMenus} from "../context-menu";
import {DocumentTabs} from "./DocumentTabs";
import "./document-tabs.css";

const contentId = "document-tabs.tabs";

/** Open-document navigation and actions; document state remains owned by the documents service. */
export function createDocumentTabsPlugin(): Plugin {
  let removeContent: (() => void) | undefined;
  let removeScope: (() => void) | undefined;
  return {
    id: "document-tabs",
    requires: [workbenchKey, documentsKey, layoutKey, shortcutsKey, i18nKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const i18n = context.get(i18nKey);
      const shortcuts = context.get(shortcutsKey);
      removeScope = shortcuts.registerScope({
        id: shortcutScopeIds.document,
        parentId: shortcutScopeIds.workbench,
        active() {
          const state = workbench.getSnapshot();
          const session = state.session;
          const workspace = session && documents.getWorkspace(session.id);
          const snapshot = workspace?.getSnapshot();
          return !!session && state.active && !state.busy
            && layout.getSnapshot().shownIds.includes(bodyEditorContentIds.main)
            && !!snapshot && !snapshot.blocked && snapshot.activeId !== null;
        },
      });
      const content: LayoutContent = {
        id: contentId,
        title: "文稿标签",
        role: "tabs",
        render: ({active}) => <DocumentTabsContent
          i18n={i18n}
          active={active}
          workbench={workbench}
          documents={documents}
          layout={layout}
          shortcuts={shortcuts}
        />,
      };
      removeContent = context.track(layout.registerContent(content));
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      const stopScope = removeScope;
      removeScope = undefined;
      try { remove?.(); }
      finally { stopScope?.(); }
    },
  };
}

function DocumentTabsContent({i18n, active, workbench, documents, layout, shortcuts}: {
  i18n: I18nService;
  active: boolean;
  workbench: WorkbenchService;
  documents: DocumentsService;
  layout: LayoutService;
  shortcuts: ShortcutsService;
}) {
  const t = useTranslation(i18n);
  const shortcutSnapshot = useSyncExternalStore(shortcuts.subscribe, shortcuts.getSnapshot, shortcuts.getSnapshot);
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = state.session;
  const workspace = session ? documents.getWorkspace(session.id) : null;
  const registeredCommandIds = new Set(shortcutSnapshot.commands.map(command => command.id));
  const closeShortcut = registeredCommandIds.has(shortcutCommandIds.closeDocument)
    ? shortcuts.getShortcut(shortcutCommandIds.closeDocument) : undefined;
  const newShortcut = registeredCommandIds.has(shortcutCommandIds.newDocument)
    ? shortcuts.getShortcut(shortcutCommandIds.newDocument) : undefined;
  return session && workspace
    ? <DocumentTabsSession t={t} key={session.id} sessionId={session.id} active={active} workbench={workbench}
        workspace={workspace} layout={layout} shortcuts={shortcuts}
        closeShortcut={closeShortcut} newShortcut={newShortcut}/>
    : null;
}

function DocumentTabsSession({t, sessionId, active, workbench, workspace, layout, shortcuts, closeShortcut, newShortcut}: {
  t: Translate;
  sessionId: string;
  active: boolean;
  workbench: WorkbenchService;
  workspace: DocumentWorkspace;
  layout: LayoutService;
  shortcuts: ShortcutsService;
  closeShortcut?: string;
  newShortcut?: string;
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
    void shortcuts.execute(shortcutCommandIds.newDocument, {sessionId})
      .catch(error => console.error("Could not create a document.", {error}));
  }

  function closeDocument(documentId: string) {
    return shortcuts.execute(shortcutCommandIds.closeDocument, {sessionId, documentId})
      .catch(error => { console.error("Could not close a document.", {error}); return false; });
  }

  return bodyVisible && snapshot.documents.length > 0 ? <DocumentTabs t={t} documents={snapshot.documents} activeDocument={snapshot.activeId}
    onSelect={workspace.select} onClose={closeDocument} onCloseMany={workspace.closeMany} onSave={workspace.save}
    onNewDocument={createDocument} newDisabled={newDisabled} disabled={disabled}
    closeShortcut={closeShortcut} newShortcut={newShortcut}/> : null;
}
