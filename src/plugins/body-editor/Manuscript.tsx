import {Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode} from "react";
import { Button, Icon } from "@lodestory/ui";
import type {OpenDocument} from "@lodestory/sdk/documents";
import type {EditorCompletion, EditorDefinition, EditorFormat, EditorHandle, EditorProps} from "@lodestory/sdk/body-editor";
import {ContextMenuRegion, type MenuEntry} from "../context-menu";
import {createEditorCallbackGuard, type EditorCallbackGuard} from "./editorCallbackGuard";

export function Manuscript({document, visible, active, readOnly = false, format, definition, connectCompletion, onChange, onSave, onEditorReady}: {
  document: OpenDocument;
  visible: boolean;
  active: boolean;
  readOnly?: boolean;
  format?: EditorFormat;
  definition?: Readonly<EditorDefinition>;
  connectCompletion?: (format: EditorFormat) => EditorCompletion;
  onChange: (content: string) => void;
  onSave: () => unknown | Promise<unknown>;
  onEditorReady: (documentId: string, handle: EditorHandle | null) => void;
}) {
  const handleRef = useRef<EditorHandle | null>(null);
  const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null);
  const handleGeneration = useRef(0);
  const latest = useRef({
    documentId: document.id, visible, active, readOnly, saveState: document.saveState,
    handle: handleRef.current, generation: handleGeneration.current, onSave,
  });
  latest.current = {
    documentId: document.id, visible, active, readOnly, saveState: document.saveState,
    handle: handleRef.current, generation: handleGeneration.current, onSave,
  };
  const ready = useCallback((handle: EditorHandle | null) => {
    if (handleRef.current !== handle) handleGeneration.current += 1;
    handleRef.current = handle;
    latest.current = {
      ...latest.current, handle, generation: handleGeneration.current,
    };
    setEditorHandle(handle);
    onEditorReady(document.id, handle);
  }, [document.id, onEditorReady]);
  const editorActive = active && visible;
  const completion = useMemo(() => format && connectCompletion?.(format), [connectCompletion, format]);
  const editorActions = editorHandle?.getContextMenuActions?.() ?? [];

  const menuItems = (contextDocumentId: string): readonly MenuEntry<string>[] => {
    const current = latest.current;
    if (contextDocumentId !== current.documentId) return [];
    const actions = current.handle?.getContextMenuActions?.() ?? [];
    const generation = current.generation;
    const handle = current.handle;
    const entries: MenuEntry<string>[] = [{
      id: "save", label: "保存",
      disabled: current.readOnly || current.saveState === "saving",
      onSelect: id => {
        const now = latest.current;
        if (id !== contextDocumentId || now.documentId !== contextDocumentId
          || !now.visible || !now.active || now.readOnly || now.saveState === "saving") return;
        return now.onSave();
      },
    }];
    if (actions.length) entries.push({id: "editor-actions-separator", type: "separator"});
    for (const action of actions) {
      entries.push({
        id: `editor:${generation}:${action.id}`,
        label: action.label,
        restoreFocus: action.restoreFocus,
        disabled: !current.visible || !current.active || current.readOnly || action.disabled,
        onSelect: id => {
          const now = latest.current;
          if (id !== contextDocumentId || now.documentId !== contextDocumentId
            || !now.visible || !now.active || now.readOnly
            || now.handle !== handle || now.generation !== generation) return;
          const liveAction = now.handle?.getContextMenuActions?.().find(candidate => candidate.id === action.id);
          if (!liveAction || liveAction.disabled) return;
          return liveAction.run();
        },
      });
    }
    return entries;
  };

  return (
    <ContextMenuRegion context={document.id} label={document.fileName + "文稿操作"}
      mode={editorActions.length ? "custom" : undefined} items={menuItems}>
    <section
      className="editor-document"
      data-editor-scroll={definition?.scrollMode ?? "document"}
      id={"editor-document-" + document.id}
      hidden={!visible}
      aria-label={document.fileName}
      tabIndex={-1}
    >
      <article className="manuscript">
        {document.saveError && <div className="document-save-error" role="alert">
          <p className="project-error">{document.saveError}</p>
          <Button variant="ghost" disabled={readOnly || document.saveState === "saving"} onClick={onSave}>重试保存</Button>
        </div>}
        {definition && format
          ? <EditorRuntime key={format + ":" + definition.id} definition={definition} documentId={document.id} format={format}
              content={document.content} readOnly={readOnly || !visible} active={editorActive}
              completion={completion} onChange={onChange} onReady={ready}/>
          : <p className="editor-document-feedback" role="status">
              {format ? "当前没有可用的编辑器实现。" : "暂不支持该文档格式。"}
            </p>}
      </article>
    </section>
    </ContextMenuRegion>
  );
}

function EditorRuntime({definition, documentId, format, content, readOnly, active, completion, onChange, onReady}: {
  definition: Readonly<EditorDefinition>;
  documentId: string;
  format: EditorFormat;
  content: string;
  readOnly: boolean;
  active: boolean;
  completion?: EditorCompletion;
  onChange: (content: string) => void;
  onReady: (handle: EditorHandle | null) => void;
}) {
  const [Editor, setEditor] = useState<ComponentType<EditorProps>>();
  const [error, setError] = useState<Error>();
  const [attempt, setAttempt] = useState(0);
  const callbacks = useRef({onChange, onReady});
  callbacks.current = {onChange, onReady};
  const activeToken = useRef<symbol | null>(null);
  const activeGuard = useRef<EditorCallbackGuard | null>(null);
  const loadEditor = definition.load;

  const invalidate = useCallback((token: symbol) => {
    if (activeToken.current !== token) return;
    const guard = activeGuard.current;
    if (guard?.token === token) guard.invalidate();
    activeToken.current = null;
    if (activeGuard.current === guard) activeGuard.current = null;
  }, []);

  const fail = useCallback((token: symbol, reason: Error) => {
    if (activeToken.current !== token) return;
    invalidate(token);
    setEditor(undefined);
    setError(reason);
  }, [invalidate]);

  useEffect(() => {
    const token = Symbol("body-editor-attempt");
    activeToken.current = token;
    const guard = createEditorCallbackGuard(token, candidate => activeToken.current === candidate, {
      onChange: content => callbacks.current.onChange(content),
      onReady: handle => callbacks.current.onReady(handle),
      onError: reason => fail(token, reason),
    });
    activeGuard.current = guard;
    setEditor(undefined);
    setError(undefined);
    void loadEditor().then(module => {
      if (activeToken.current === token) setEditor(() => module.default);
    }).catch(reason => {
      fail(token, asError(reason));
    });
    return () => invalidate(token);
  }, [loadEditor, attempt, fail, invalidate]);

  const retry = useCallback(() => {
    const token = activeToken.current;
    if (token) invalidate(token);
    setError(undefined);
    setEditor(undefined);
    setAttempt(value => value + 1);
  }, [invalidate]);
  if (error) return <div className="editor-document-feedback" role="alert">
    <p className="project-error">编辑器加载或运行失败：{error.message}</p>
    <Button variant="ghost" onClick={retry}>重试加载编辑器</Button>
  </div>;
  if (!Editor) return <p className="editor-document-feedback" role="status">正在加载编辑器…</p>;

  const guard = activeGuard.current;
  if (!guard) return <p className="editor-document-feedback" role="status">正在准备编辑器…</p>;
  const props: EditorProps = {
    documentId, format, content, readOnly, active, completion,
    onChange: guard.onChange,
    onReady: guard.onReady,
    onError: guard.onError,
  };
  return <EditorErrorBoundary key={attempt} onError={guard.onError}>
    <Editor {...props}/>
  </EditorErrorBoundary>;
}

class EditorErrorBoundary extends Component<{children: ReactNode; onError: (error: Error) => void}, {error?: Error}> {
  state: {error?: Error} = {};

  static getDerivedStateFromError(reason: unknown) {
    return {error: asError(reason)};
  }

  componentDidCatch(reason: Error, _info: ErrorInfo) {
    this.props.onError(asError(reason));
  }

  render() {
    if (this.state.error) {
      return <p className="editor-document-feedback" role="alert">编辑器运行失败：{this.state.error.message}</p>;
    }
    return this.props.children;
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function EmptyDocument({projectPath, onCreate, disabled}: {projectPath: string; onCreate: () => void; disabled: boolean}) {
  return (
    <ContextMenuRegion label="文稿工作区操作" items={[
      {id: "new-document", label: "新建文档", icon: <Icon name="plus"/>, disabled, restoreFocus: false,
        onSelect: () => { if (!disabled) onCreate(); }},
    ]}>
    <section className="editor-empty" aria-labelledby="editor-empty-title" tabIndex={0}>
      <Icon name="book" size="brand"/>
      <h1 id="editor-empty-title" tabIndex={-1}>作品已打开</h1>
      <p className="editor-project-path" title={projectPath}>{projectPath}</p>
      <p>选择文档，或新建文档开始写作。</p>
      <Button variant="primary" onClick={onCreate} disabled={disabled}><Icon name="plus"/>新建文档</Button>
    </section>
    </ContextMenuRegion>
  );
}
