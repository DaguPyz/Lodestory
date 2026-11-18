import {createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode} from "react";
import {isTauri} from "@tauri-apps/api/core";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {EditorCompletion, EditorDefinition, EditorFormat} from "@lodestory/sdk/body-editor";
import {useContextMenus} from "../context-menu";
import {useDocumentWorkspace} from "./useDocumentWorkspace";
import type {BodyEditorModel} from "./bodyEditorModel";
import "./body-editor.css";

type EditorResolver = (format: EditorFormat) => Readonly<EditorDefinition> | undefined;
type CompletionConnector = (sessionId: string, format: EditorFormat) => EditorCompletion;

function useBodyEditorModel(model: BodyEditorModel, workbench: WorkbenchService, resolveEditor: EditorResolver,
  connectCompletion: CompletionConnector, sessionId: string) {
  const data = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const workspace = useDocumentWorkspace(data.workspace);
  const connect = useCallback((format: EditorFormat) => connectCompletion(sessionId, format), [connectCompletion, sessionId]);
  return {
    ...data,
    workspace,
    resolveEditor,
    connectCompletion: connect,
    busy: state.busy || workspace.blocked,
    newDisabled: !isTauri() || workspace.creating || workspace.blocked || state.busy || !state.active,
    requestNewDocument: model.requestNewDocument,
    finishSearchTarget: model.finishSearchTarget,
  };
}

const BodyEditorContext = createContext<ReturnType<typeof useBodyEditorModel> | null>(null);

/** 私有 React 接入层；其他功能通过 SDK 操作文档，不共享此 Context。 */
export function useBodyEditorContext() {
  const editor = useContext(BodyEditorContext);
  if (!editor) throw new Error("Body editor contents require a body editor session context.");
  return editor;
}

export function BodyEditorContentProvider({workbench, models, resolveEditor, connectCompletion, children}: {
  workbench: WorkbenchService;
  models: ReadonlyMap<string, BodyEditorModel>;
  resolveEditor: EditorResolver;
  connectCompletion: CompletionConnector;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const sessionId = state.session?.id;
  const model = sessionId && models.get(sessionId);
  return model && sessionId
    ? <BodyEditorModelProvider key={sessionId} sessionId={sessionId} model={model} workbench={workbench}
        resolveEditor={resolveEditor} connectCompletion={connectCompletion}>{children}</BodyEditorModelProvider> : null;
}

function BodyEditorModelProvider({model, workbench, resolveEditor, connectCompletion, sessionId, children}: {
  model: BodyEditorModel; workbench: WorkbenchService; resolveEditor: EditorResolver;
  connectCompletion: CompletionConnector; sessionId: string; children: ReactNode;
}) {
  const value = useBodyEditorModel(model, workbench, resolveEditor, connectCompletion, sessionId);
  return <BodyEditorContext.Provider value={value}>{children}</BodyEditorContext.Provider>;
}

/** 只在 main 内容安装一次；隐藏或阻塞时停止快捷键，自动保存由文档插件继续执行。 */
export function BodyEditorInteractions({active}: {active: boolean}) {
  useBodyEditorContext();
  const menus = useContextMenus();
  useEffect(() => {
    menus.closeAll();
  }, [active, menus]);
  return null;
}
