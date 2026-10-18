import {useEffect, useRef} from "react";
import {IconButton} from "../../components/Button";
import {Icon} from "../../components/Icon";
import {BodyEditorInteractions, useBodyEditorContext} from "./BodyEditorContext";
import {EmptyDocument, Manuscript} from "./Manuscript";

export function BodyEditor({active}: {active: boolean}) {
  const editor = useBodyEditorContext();
  const {workspace} = editor;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || editor.busy) return;
    const frame = requestAnimationFrame(() => {
      // 在插件自己的容器中定位，避免依赖全局文档 ID 或第三方编辑器实例。
      const target = workspace.activeId
        ? root.current?.querySelector<HTMLTextAreaElement>(".editor-document:not([hidden]) .manuscript-input")
        : root.current?.querySelector<HTMLElement>("#editor-empty-title");
      target?.focus({preventScroll: true});
    });
    return () => cancelAnimationFrame(frame);
  }, [active, editor.busy, workspace.activeId, editor.revealVersion]);
  const disabled = editor.busy || !active;
  return <div className="editor-content-main" ref={root} aria-busy={editor.busy}>
    <BodyEditorInteractions active={active}/>
    {workspace.error && <div className="editor-document-feedback" role="alert">
      <p className="project-error">{workspace.error}</p>
      <IconButton label="关闭提示" disabled={disabled} onClick={workspace.clearError}><Icon name="close" size="small"/></IconButton>
    </div>}
    {(workspace.openingPath || workspace.creating) && <p className="editor-document-feedback" role="status">
      {workspace.creating ? "正在创建文档…" : "正在打开文档…"}
    </p>}
    <div className="editor-document-stack">
      {workspace.documents.length ? workspace.documents.map(document => <Manuscript key={document.id} document={document}
        projectName={editor.projectName} visible={document.id === workspace.activeId} readOnly={disabled}
        onChange={content => { if (!disabled) workspace.update(document.id, content); }} onSave={() => workspace.save(document.id)}/>)
        : <EmptyDocument projectPath={editor.projectPath} onCreate={() => editor.requestNewDocument()} disabled={editor.newDisabled || !active}/>}
    </div>
  </div>;
}
