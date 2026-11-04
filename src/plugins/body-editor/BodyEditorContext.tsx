import {createContext, useContext, useEffect, useSyncExternalStore, type ReactNode} from "react";
import {isTauri} from "@tauri-apps/api/core";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {EditorDefinition, EditorFormat} from "@lodestory/sdk/body-editor";
import {useContextMenus} from "../context-menu";
import {useDocumentWorkspace} from "./useDocumentWorkspace";
import type {BodyEditorModel} from "./bodyEditorModel";
import type {ResolvedEditorConversion} from "./bodyEditorRegistry";
import "./body-editor.css";

type EditorResolver = (format: EditorFormat) => Readonly<EditorDefinition> | undefined;
type EditorConversionResolver = (format: EditorFormat) => readonly ResolvedEditorConversion[];

function useBodyEditorModel(model: BodyEditorModel, workbench: WorkbenchService, resolveEditor: EditorResolver, resolveConversions: EditorConversionResolver) {
  const data = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const workspace = useDocumentWorkspace(data.workspace);
  return {
    ...data,
    workspace,
    resolveEditor,
    resolveConversions,
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

export function BodyEditorContentProvider({workbench, models, resolveEditor, resolveConversions, children}: {
  workbench: WorkbenchService;
  models: ReadonlyMap<string, BodyEditorModel>;
  resolveEditor: EditorResolver;
  resolveConversions: EditorConversionResolver;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const model = state.session && models.get(state.session.id);
  return model ? <BodyEditorModelProvider key={state.session!.id} model={model} workbench={workbench} resolveEditor={resolveEditor} resolveConversions={resolveConversions}>{children}</BodyEditorModelProvider> : null;
}

function BodyEditorModelProvider({model, workbench, resolveEditor, resolveConversions, children}: {model: BodyEditorModel; workbench: WorkbenchService; resolveEditor: EditorResolver; resolveConversions: EditorConversionResolver; children: ReactNode}) {
  const value = useBodyEditorModel(model, workbench, resolveEditor, resolveConversions);
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
