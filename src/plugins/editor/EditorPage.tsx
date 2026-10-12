import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { DocumentTabs } from "./DocumentTabs";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorToolbar } from "./EditorToolbar";
import { EmptyDocument, Manuscript } from "./Manuscript";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { ProjectTree } from "./ProjectTree";
import { ReferencePanel } from "./ReferencePanel";
import { createDocument, documentErrorMessage, listDocuments, type TreeEntry } from "../../documents/documentApi";
import { useDocumentWorkspace } from "../../documents/useDocumentWorkspace";
import "../../styles/editor.css";
import { useContextMenus } from "../context-menu";

type PanelPreference = "auto" | "open" | "closed";
type EditorPageProps = {
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

export function EditorPage({ projectName, projectPath, active, onBack, onOpenSettings }: EditorPageProps) {
  const menus = useContextMenus();
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, rem: 16 }));
  const [treePreference, setTreePreference] = useState<PanelPreference>("auto");
  const [referencePreference, setReferencePreference] = useState<PanelPreference>("auto");
  const [focusMode, setFocusMode] = useState(false);
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
  const { documents, activeId, currentDocument } = workspace;
  const newDisabled = !isTauri() || treeLoading || creating;

  useEffect(() => {
    menus.closeAll();
    if (!active) {
      setCreateDialogOpen(false);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const title = root.current?.querySelector<HTMLElement>(".editor-document:not([hidden]) .manuscript-title")
        ?? root.current?.querySelector<HTMLElement>("#editor-empty-title");
      title?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, menus]);

  // These thresholds retain a 560px main workspace before folding docked panels.
  const treeDocked = viewport.width >= 54 * viewport.rem;
  const referenceDocked = viewport.width >= 74 * viewport.rem;
  const treeVisible = !focusMode && (treePreference === "open" || (treePreference === "auto" && treeDocked));
  const referenceVisible = !focusMode && (referencePreference === "open" || (referencePreference === "auto" && referenceDocked));

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
    if (!active) return;
    function saveShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.isComposing) {
        event.preventDefault();
        void workspace.saveAll();
      }
    }
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [active, workspace.saveAll]);

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
    } finally {
      leaving.current = false;
    }
  }

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;

    function measure() {
      const width = element!.getBoundingClientRect().width;
      if (width === 0) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setViewport((previous) => previous.width === width && previous.rem === rem ? previous : { width, rem });
    }
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!focusMode || !active) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.isComposing) {
        setFocusMode(false);
        document.getElementById("editor-focus-toggle")?.focus();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [focusMode, active]);

  function toggleTree() {
    setTreePreference(treeVisible ? "closed" : "open");
    if (!treeVisible && !treeDocked) setReferencePreference("auto");
  }

  function toggleReference() {
    setReferencePreference(referenceVisible ? "closed" : "open");
    if (!referenceVisible && !referenceDocked && !treeDocked) setTreePreference("auto");
  }

  function closeReference() {
    setReferencePreference("closed");
    document.getElementById("editor-reference-toggle")?.focus();
  }

  function closeTree() {
    setTreePreference("closed");
    document.getElementById("editor-tree-toggle")?.focus();
  }

  function openDocument(path: string) {
    setSelectedFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    if (!treeDocked) {
      setTreePreference("auto");
    }
    return workspace.open(path);
  }

  return (
    <div className="editor-layout" data-ui-density="comfortable" ref={root}>
      <EditorToolbar
        active={active}
        projectName={projectName} focusMode={focusMode} referenceVisible={referenceVisible}
        treeVisible={treeVisible} onToggleTree={toggleTree}
        onToggleFocus={() => setFocusMode((previous) => !previous)}
        onToggleReference={toggleReference} onBack={() => void leave(onBack)} onOpenSettings={() => void leave(onOpenSettings)}
      />
      <div
        className="editor-workspace"
        data-tree-docked={treeVisible && treeDocked}
        data-reference-docked={referenceVisible && referenceDocked}
        data-focus={focusMode}
      >
        <aside className="editor-activitybar" hidden={focusMode} aria-label="工作空间工具">
          <div className="editor-activitybar-tools">
            <IconButton
              id="editor-tree-toggle" label="项目文件"
              aria-controls="editor-project-tree" aria-pressed={treeVisible} onClick={toggleTree}
            ><Icon name="file" /></IconButton>
            <IconButton label="版本管理" disabled><Icon name="history" /></IconButton>
            <IconButton label="搜索" disabled><Icon name="search" /></IconButton>
          </div>
          <IconButton label="设置" onClick={() => void leave(onOpenSettings)}><Icon name="settings" /></IconButton>
        </aside>

        <ProjectTree
          projectName={projectName} entries={entries} activeDocument={activeId} openingPath={workspace.openingPath}
          loading={treeLoading} error={treeError} newDisabled={newDisabled}
          onNewDocument={showNewDocument} onReload={() => void reloadTree()} onSelectFolder={setSelectedFolder}
          visible={treeVisible} overlay={!treeDocked} onOpenDocument={openDocument} onClose={closeTree}
        />

        <main className="editor-main" aria-label="文稿工作区">
          <DocumentTabs documents={documents} activeDocument={activeId} onSelect={workspace.select} onClose={workspace.close}
            onSave={workspace.save} onNewDocument={() => showNewDocument()} newDisabled={newDisabled} />
          {workspace.error && <div className="editor-document-feedback" role="alert">
            <p className="project-error">{workspace.error}</p>
            <IconButton label="关闭提示" onClick={workspace.clearError}><Icon name="close" size="small" /></IconButton>
          </div>}
          {workspace.openingPath && <p className="editor-document-feedback" role="status">正在打开文档…</p>}
          <div className="editor-document-stack">
            {documents.length > 0 ? documents.map((document) => (
              <Manuscript key={document.id} document={document} projectName={projectName} visible={document.id === activeId}
                onChange={(content) => workspace.update(document.id, content)} onSave={() => workspace.save(document.id)} />
            )) : <EmptyDocument projectPath={projectPath} onCreate={() => showNewDocument()} disabled={newDisabled} />}
          </div>
        </main>

        <ReferencePanel visible={referenceVisible} overlay={!referenceDocked} onClose={closeReference} />
      </div>
      <EditorStatusBar document={currentDocument} />
      {active && createDialogOpen && <NewDocumentDialog projectName={projectName} entries={entries} initialParent={selectedFolder}
        busy={creating} error={createError} onClose={() => setCreateDialogOpen(false)} onCreate={create} />}
    </div>
  );
}
