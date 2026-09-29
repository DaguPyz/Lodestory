import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { DocumentTabs } from "./DocumentTabs";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorToolbar } from "./EditorToolbar";
import { EmptyDocument, Manuscript } from "./Manuscript";
import { ProjectTree } from "./ProjectTree";
import { ReferencePanel } from "./ReferencePanel";
import { previewDocuments } from "./previewData";
import "../../styles/editor.css";

type PanelPreference = "auto" | "open" | "closed";
type EditorPageProps = {
  projectName: string;
  active: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
};

export function EditorPage({ projectName, active, onBack, onOpenSettings }: EditorPageProps) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, rem: 16 }));
  const [treePreference, setTreePreference] = useState<PanelPreference>("auto");
  const [referencePreference, setReferencePreference] = useState<PanelPreference>("auto");
  const [focusMode, setFocusMode] = useState(false);
  const [openIds, setOpenIds] = useState(["rain", "outline"]);
  const [activeId, setActiveId] = useState<string | null>("rain");

  // These thresholds retain a 560px main workspace before folding docked panels.
  const treeDocked = viewport.width >= 54 * viewport.rem;
  const referenceDocked = viewport.width >= 74 * viewport.rem;
  const treeVisible = !focusMode && (treePreference === "open" || (treePreference === "auto" && treeDocked));
  const referenceVisible = !focusMode && (referencePreference === "open" || (referencePreference === "auto" && referenceDocked));
  const documents = openIds.flatMap((id) => {
    const document = previewDocuments.find((item) => item.id === id);
    return document ? [document] : [];
  });
  const currentDocument = previewDocuments.find((document) => document.id === activeId);

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

  function openDocument(id: string) {
    if (!previewDocuments.some((document) => document.id === id)) return;
    setOpenIds((previous) => previous.includes(id) ? previous : [...previous, id]);
    setActiveId(id);
    if (!treeDocked) {
      setTreePreference("auto");
      requestAnimationFrame(() => document.getElementById(`editor-document-title-${id}`)?.focus());
    }
  }

  function closeDocument(id: string) {
    const remaining = openIds.filter((item) => item !== id);
    const nextActive = activeId === id ? remaining[Math.max(0, openIds.indexOf(id) - 1)] ?? null : activeId;
    setOpenIds(remaining);
    setActiveId(nextActive);
    requestAnimationFrame(() => document.getElementById(nextActive ? `document-tab-${nextActive}` : "editor-empty-title")?.focus());
  }

  return (
    <div className="editor-layout" data-ui-density="comfortable" ref={root}>
      <EditorToolbar
        active={active}
        projectName={projectName} focusMode={focusMode} referenceVisible={referenceVisible}
        treeVisible={treeVisible} onToggleTree={toggleTree}
        onToggleFocus={() => setFocusMode((previous) => !previous)}
        onToggleReference={toggleReference} onBack={onBack} onOpenSettings={onOpenSettings}
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
          <IconButton label="设置" onClick={onOpenSettings}><Icon name="settings" /></IconButton>
        </aside>

        <ProjectTree
          projectName={projectName} activeDocument={activeId}
          visible={treeVisible} overlay={!treeDocked} onOpenDocument={openDocument} onClose={closeTree}
        />

        <main className="editor-main" aria-label="文稿工作区">
          <DocumentTabs documents={documents} activeDocument={activeId} onSelect={setActiveId} onClose={closeDocument} />
          <div className="editor-document-stack">
            {documents.length > 0 ? documents.map((document) => (
              <Manuscript key={document.id} document={document} visible={document.id === activeId} />
            )) : <EmptyDocument />}
          </div>
        </main>

        <ReferencePanel visible={referenceVisible} overlay={!referenceDocked} onClose={closeReference} />
      </div>
      <EditorStatusBar document={currentDocument} />
    </div>
  );
}
