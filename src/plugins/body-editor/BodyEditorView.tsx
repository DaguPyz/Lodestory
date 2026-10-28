import {useCallback, useEffect, useRef} from "react";
import { IconButton, Icon } from "@lodestory/ui";
import type {EditorHandle} from "@lodestory/sdk/body-editor";
import {getEditorFormat} from "./bodyEditorRegistry";
import {BodyEditorInteractions, useBodyEditorContext} from "./BodyEditorContext";
import {EmptyDocument, Manuscript} from "./Manuscript";

export function BodyEditor({active}: {active: boolean}) {
  const editor = useBodyEditorContext();
  const {workspace} = editor;
  const root = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<string, EditorHandle>());
  const contentReaders = useRef(new Map<string, () => void>());
  const mounted = useRef(true);
  const focusFrames = useRef(new Set<number>());
  const focusState = useRef({active, busy: editor.busy, activeId: workspace.activeId});
  focusState.current = {active, busy: editor.busy, activeId: workspace.activeId};

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const frame of focusFrames.current) cancelAnimationFrame(frame);
      focusFrames.current.clear();
      for (const remove of contentReaders.current.values()) remove();
      contentReaders.current.clear();
      handles.current.clear();
    };
  }, []);

  const onEditorReady = useCallback((documentId: string, handle: EditorHandle | null) => {
    if (!mounted.current) return;
    contentReaders.current.get(documentId)?.();
    contentReaders.current.delete(documentId);
    if (handle && isOpen()) {
      handles.current.set(documentId, handle);
      if (handle.flushContent && workspace.registerContentReader) {
        contentReaders.current.set(documentId, workspace.registerContentReader(documentId, content => handle.flushContent!(content)));
      }
      const state = focusState.current;
      if (state.active && !state.busy && state.activeId === documentId) {
        const frame = requestAnimationFrame(() => {
          focusFrames.current.delete(frame);
          if (!mounted.current) return;
          const latest = focusState.current;
          if (latest.active && !latest.busy && latest.activeId === documentId && isOpen()) {
            handles.current.get(documentId)?.focus();
          }
        });
        focusFrames.current.add(frame);
      }
    } else {
      handles.current.delete(documentId);
    }

    function isOpen() {
      return workspace.getSnapshot().documents.some(document => document.id === documentId);
    }
  }, [workspace.getSnapshot, workspace.registerContentReader]);

  useEffect(() => {
    if (!active || editor.busy) return;
    const frame = requestAnimationFrame(() => {
      if (!mounted.current) return;
      if (workspace.activeId) {
        const handle = handles.current.get(workspace.activeId);
        if (handle) handle.focus();
        else root.current?.querySelector<HTMLElement>(".editor-document:not([hidden])")?.focus({preventScroll: true});
      } else {
        root.current?.querySelector<HTMLElement>("#editor-empty-title")?.focus({preventScroll: true});
      }
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
      {workspace.documents.length ? workspace.documents.map(document => {
        const visible = document.id === workspace.activeId;
        const documentActive = visible && active;
        const format = getEditorFormat(document.fileName);
        const definition = format ? editor.resolveEditor(format) : undefined;
        const conversions = format ? editor.resolveConversions(format) : [];
        return <Manuscript key={document.id} document={document}
          visible={visible} active={documentActive}
          readOnly={disabled || workspace.blocked || !visible || workspace.deletingPath === document.path}
          format={format} definition={definition} conversions={conversions} onEditorReady={onEditorReady}
          onChange={content => {
            const latest = workspace.getSnapshot();
            const focus = focusState.current;
            const acceptingRenameInput = latest.renamingPath !== null;
            if (focus.active && !focus.busy && (acceptingRenameInput || (!latest.blocked && latest.activeId === document.id))
              && (acceptingRenameInput || latest.documents.some(open => open.id === document.id))) {
              workspace.update(document.id, content);
            }
          }}
          onSave={() => workspace.save(document.id)}
          onSaveAs={async ({extension, content}) => {
            const normalizedExtension = extension.trim().replace(/^\./, "");
            if (!/^[a-z0-9][a-z0-9_-]*$/i.test(normalizedExtension)) {
              throw new Error("文件扩展名无效，无法转换保存。");
            }
            const latest = workspace.getSnapshot();
            const focus = focusState.current;
            if (!documentActive || !focus.active || focus.busy || latest.activeId !== document.id
              || !latest.documents.some(open => open.id === document.id)) {
              throw new Error("当前文稿已不可编辑，无法转换保存。");
            }
            const extensionIndex = document.fileName.lastIndexOf(".");
            const basename = extensionIndex > 0 ? document.fileName.slice(0, extensionIndex) : document.fileName;
            await workspace.saveAs(document.id, `${basename}.${normalizedExtension}`, content);
          }}/>
      }) : <EmptyDocument projectPath={editor.projectPath} onCreate={() => editor.requestNewDocument()} disabled={editor.newDisabled || !active}/>}
    </div>
  </div>;
}
