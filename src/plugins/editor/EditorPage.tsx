import { isTauri } from "@tauri-apps/api/core";
import { createContext, useContext, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createDocument, documentErrorMessage, listDocuments, type TreeEntry } from "../../documents/documentApi";
import { useDocumentWorkspace } from "../../documents/useDocumentWorkspace";
import type {LayoutService} from "@lodestory/sdk/layout";
import {editorContentIds} from "./editorContentIds";
import "./editor.css";
import {NewDocumentDialog} from "./NewDocumentDialog";
import { useContextMenus } from "../context-menu";

type EditorPageProps = {
  layout: LayoutService;
  projectName: string;
  projectPath: string;
  active: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
};

function insertDocument(entries: TreeEntry[], path: string, name: string): TreeEntry[] {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!parent) return [...entries.filter((entry) => entry.path !== path), { path, name }];
  return entries.map((entry) => {
    if (!entry.children) return entry;
    if (entry.path === parent) return { ...entry, children: [...entry.children.filter((child) => child.path !== path), { path, name }] };
    return { ...entry, children: insertDocument(entry.children, path, name) };
  });
}

function useEditorModel({ layout, projectName, projectPath, active, onBack, onOpenSettings }: EditorPageProps) {
  const menus = useContextMenus();
  const layoutSnapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const mainActive = active && layoutSnapshot.shownIds.includes(editorContentIds.main);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const treeSequence = useRef(0);
  const createPending = useRef(false);
  const leaving = useRef(false);
  const workspace = useDocumentWorkspace(projectPath);
  const newDisabled = !isTauri() || treeLoading || creating;

  useEffect(() => {
    menus.closeAll();
    if (!active) {
      setCreateDialogOpen(false);
      return;
    }
  }, [active, menus]);

  const reloadTree = useCallback(async () => {
    const sequence = ++treeSequence.current;
    setTreeLoading(true);
    setTreeError(null);
    try {
      const records = await listDocuments(projectPath);
      if (sequence === treeSequence.current) setEntries(records);
    } catch (cause) {
      if (sequence === treeSequence.current) setTreeError(documentErrorMessage(cause));
    } finally {
      if (sequence === treeSequence.current) setTreeLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (active) void reloadTree();
    return () => { treeSequence.current += 1; };
  }, [active, reloadTree]);

  useEffect(() => {
    if (!mainActive) return;
    function saveShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.isComposing) {
        event.preventDefault();
        void workspace.saveAll();
      }
    }
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [mainActive, workspace.saveAll]);

  function showNewDocument(parentPath = selectedFolder) {
    menus.closeAll();
    setSelectedFolder(parentPath);
    setCreateError(null);
    setCreateDialogOpen(true);
  }

  async function create(parentPath: string, name: string) {
    if (createPending.current) return;
    createPending.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const record = await createDocument(projectPath, parentPath, name);
      setEntries((previous) => insertDocument(previous, record.path, record.fileName));
      setCreateDialogOpen(false);
      setSelectedFolder(parentPath);
      layout.show(editorContentIds.main);
      workspace.openCreated(record);
      await reloadTree();
    } catch (cause) {
      setCreateError(documentErrorMessage(cause));
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }

  async function leave(action: () => void) {
    if (!active || leaving.current) return;
    leaving.current = true;
    try {
      if (await workspace.saveAll()) action();
      else layout.show(editorContentIds.main);
    } finally {
      leaving.current = false;
    }
  }

  function openDocument(path: string) {
    setSelectedFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    layout.show(editorContentIds.main);
    return workspace.open(path);
  }

  return {
    projectName, projectPath, workspace, entries, treeLoading, treeError, newDisabled,
    selectedFolder, setSelectedFolder, showNewDocument, reloadTree, openDocument,
    createDialogOpen, creating, createError, create, closeCreateDialog: () => setCreateDialogOpen(false),
    leaveProject: () => void leave(onBack), openSettings: () => void leave(onOpenSettings),
  };
}

const EditorContext = createContext<ReturnType<typeof useEditorModel> | null>(null);

/** 登记内容共享当前项目的会话；布局实现无需知道此 Context。 */
export function useEditorContext() {
  const model = useContext(EditorContext);
  if (!model) throw new Error("Editor contents require an editor project context.");
  return model;
}

export function EditorPage(props: EditorPageProps) {
  const model = useEditorModel(props);
  const View = props.layout.View;
  return <EditorContext.Provider value={model}>
    <View active={props.active}/>
    {props.active && model.createDialogOpen && <NewDocumentDialog projectName={model.projectName} entries={model.entries}
      initialParent={model.selectedFolder} busy={model.creating} error={model.createError}
      onClose={model.closeCreateDialog} onCreate={model.create}/>}
  </EditorContext.Provider>;
}
