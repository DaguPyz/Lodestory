import {useEffect, useRef} from "react";
import {IconButton} from "../../components/Button";
import {Icon} from "../../components/Icon";
import {EditorInteractions, useEditorContext} from "./EditorPage";
import {EditorToolbar} from "./EditorToolbar";
import {DocumentTabs} from "./DocumentTabs";
import {EmptyDocument, Manuscript} from "./Manuscript";
import {EditorStatusBar} from "./EditorStatusBar";

export function EditorActions({active}: {active: boolean}) {
  const editor = useEditorContext();
  return <EditorToolbar active={active} projectName={editor.projectName} onBack={editor.leaveProject} onOpenSettings={editor.openSettings}/>;
}

export function EditorMain({active}: {active: boolean}) {
  const editor = useEditorContext();
  const {workspace} = editor;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const title = root.current?.querySelector<HTMLElement>(".editor-document:not([hidden]) .manuscript-title, #editor-empty-title");
      title?.focus({preventScroll: true});
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!active || !workspace.activeId) return;
    const frame = requestAnimationFrame(() => document.getElementById(`editor-document-input-${workspace.activeId}`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, workspace.activeId]);
  return <div className="editor-content-main" ref={root} aria-busy={editor.busy}>
    <EditorInteractions active={active}/>
    <DocumentTabs documents={workspace.documents} activeDocument={workspace.activeId} onSelect={workspace.select}
      onClose={workspace.close} onSave={workspace.save} onNewDocument={() => editor.requestNewDocument()} newDisabled={editor.newDisabled} disabled={editor.busy}/>
    {workspace.error && <div className="editor-document-feedback" role="alert">
      <p className="project-error">{workspace.error}</p>
      <IconButton label="关闭提示" onClick={workspace.clearError}><Icon name="close" size="small"/></IconButton>
    </div>}
    {(workspace.openingPath || workspace.creating) && <p className="editor-document-feedback" role="status">
      {workspace.creating ? "正在创建文档…" : "正在打开文档…"}
    </p>}
    <div className="editor-document-stack">
      {workspace.documents.length ? workspace.documents.map(document => <Manuscript key={document.id} document={document}
        projectName={editor.projectName} visible={document.id === workspace.activeId} readOnly={editor.busy || !active}
        onChange={content => workspace.update(document.id, content)} onSave={() => workspace.save(document.id)}/>)
        : <EmptyDocument projectPath={editor.projectPath} onCreate={() => editor.requestNewDocument()} disabled={editor.newDisabled}/>}
    </div>
  </div>;
}

export function EditorStatus() {
  return <EditorStatusBar document={useEditorContext().workspace.currentDocument}/>;
}
