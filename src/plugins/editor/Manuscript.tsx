import { useLayoutEffect, useRef } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import type { WorkspaceDocument } from "../../documents/documentApi";
import { ContextMenuRegion } from "../context-menu";

export function Manuscript({ document, projectName, visible, readOnly = false, onChange, onSave }: {
  document: WorkspaceDocument;
  projectName: string;
  visible: boolean;
  readOnly?: boolean;
  onChange: (content: string) => void;
  onSave: () => unknown | Promise<unknown>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!visible || !input.current) return;
    const element = input.current;
    let width = element.getBoundingClientRect().width;
    function resize() {
      element.style.height = "auto";
      element.style.height = `${Math.max(320, element.scrollHeight)}px`;
    }
    resize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        const nextWidth = element.getBoundingClientRect().width;
        if (nextWidth === width) return;
        width = nextWidth;
        resize();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [document.content, visible]);

  const title = document.fileName.replace(/\.(md|markdown|txt)$/i, "");
  const folder = document.path.includes("/") ? document.path.slice(0, document.path.lastIndexOf("/")) : "";
  return (
    <ContextMenuRegion context={document.id} label={`${document.fileName}文稿操作`} items={[
      { id: "save", label: "保存", disabled: document.saveState === "saving",
        onSelect: (id) => { if (visible && document.id === id) return onSave(); } },
    ]}>
    <section
      className="editor-document"
      id={`editor-document-${document.id}`}
      hidden={!visible}
      aria-labelledby={`editor-document-title-${document.id}`}
      tabIndex={-1}
    >
      <article className="manuscript">
        <header className="manuscript-header">
          <p className="manuscript-context">{projectName}{folder && ` · ${folder}`}</p>
          <h1 className="manuscript-title" id={`editor-document-title-${document.id}`} tabIndex={-1}>{title}</h1>
        </header>
        {document.saveError && <div className="document-save-error" role="alert">
          <p className="project-error">{document.saveError}</p>
          <Button variant="ghost" onClick={onSave}>重试保存</Button>
        </div>}
        <textarea ref={input} id={`editor-document-input-${document.id}`} className="manuscript-body manuscript-input"
          aria-label={`${document.fileName} 正文`} placeholder="从这里开始写作…" value={document.content} readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      </article>
    </section>
    </ContextMenuRegion>
  );
}

export function EmptyDocument({ projectPath, onCreate, disabled }: { projectPath: string; onCreate: () => void; disabled: boolean }) {
  return (
    <ContextMenuRegion label="文稿工作区操作" items={[
      { id: "new-document", label: "新建文档", icon: <Icon name="plus" />, disabled, restoreFocus: false,
        onSelect: () => { if (!disabled) onCreate(); } },
    ]}>
    <section className="editor-empty" aria-labelledby="editor-empty-title" tabIndex={0}>
      <Icon name="book" size="brand" />
      <h1 id="editor-empty-title" tabIndex={-1}>作品已打开</h1>
      <p className="editor-project-path" title={projectPath}>{projectPath}</p>
      <p>选择文档，或新建文档开始写作。</p>
      <Button variant="primary" onClick={onCreate} disabled={disabled}><Icon name="plus" />新建文档</Button>
    </section>
    </ContextMenuRegion>
  );
}
