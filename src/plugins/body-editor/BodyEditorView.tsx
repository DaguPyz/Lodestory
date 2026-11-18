import {useCallback, useEffect, useRef, useState} from "react";
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
  const [readyVersion, setReadyVersion] = useState(0);
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
      // A lazy editor may finish loading after the user has moved to another control.
      if (state.active && !state.busy && state.activeId === documentId && root.current?.contains(document.activeElement)) {
        const frame = requestAnimationFrame(() => {
          focusFrames.current.delete(frame);
          if (!mounted.current) return;
          const latest = focusState.current;
          if (latest.active && !latest.busy && latest.activeId === documentId && isOpen()
            && root.current?.contains(document.activeElement)) {
            handles.current.get(documentId)?.focus();
          }
        });
        focusFrames.current.add(frame);
      }
    } else {
      handles.current.delete(documentId);
    }
    setReadyVersion(value => value + 1);

    function isOpen() {
      return workspace.getSnapshot().documents.some(document => document.id === documentId);
    }
  }, [workspace.getSnapshot, workspace.registerContentReader]);

  useEffect(() => {
    const target = editor.searchTarget;
    if (!target || !active || editor.busy) return;
    if (workspace.activeId !== target.documentId) {
      editor.finishSearchTarget(target, true);
      return;
    }
    const handle = handles.current.get(target.documentId);
    if (!handle) return;
    const current = workspace.getSnapshot().documents.find(document => document.id === target.documentId);
    let success = false;
    try { success = current?.content === target.content && Boolean(handle.revealSearchRange?.(target.range)); }
    finally { editor.finishSearchTarget(target, success); }
  }, [active, editor.busy, editor.searchTarget, editor.finishSearchTarget, readyVersion, workspace.activeId, workspace.getSnapshot]);

  useEffect(() => {
    if (!active || editor.busy) return;
    const focusedBeforeFrame = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (!mounted.current || document.activeElement !== focusedBeforeFrame) return;
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
    {editor.searchError && <p className="editor-document-feedback" role="alert">{editor.searchError}</p>}
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
        return <Manuscript key={document.id} document={document}
          visible={visible} active={documentActive}
          readOnly={disabled || workspace.blocked || !visible || workspace.deletingPath === document.path}
          format={format} definition={definition} onEditorReady={onEditorReady} connectCompletion={editor.connectCompletion}
          onChange={content => {
            const latest = workspace.getSnapshot();
            const focus = focusState.current;
            const acceptingRenameInput = latest.renamingPath !== null;
            if (focus.active && !focus.busy && (acceptingRenameInput || (!latest.blocked && latest.activeId === document.id))
              && (acceptingRenameInput || latest.documents.some(open => open.id === document.id))) {
              workspace.update(document.id, content);
            }
          }}
          onSave={() => workspace.save(document.id)}/>
      }) : <EmptyDocument projectPath={editor.projectPath} onCreate={() => editor.requestNewDocument()} disabled={editor.newDisabled || !active}/>}
    </div>
  </div>;
}
