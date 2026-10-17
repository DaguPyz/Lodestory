import {createContext, useContext, useEffect, useSyncExternalStore, type ReactNode} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import {useDocumentWorkspace} from "../../documents/useDocumentWorkspace";
import {useContextMenus} from "../context-menu";
import type {EditorModel} from "./editorModel";
import "./editor.css";

function useEditorModel(model: EditorModel, workbench: WorkbenchService) {
  const data = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const workspace = useDocumentWorkspace(data.workspace);
  return {...data, workspace, busy: state.busy,
    setSelectedFolder: model.setSelectedFolder, showNewDocument: model.showNewDocument,
    reloadTree: model.reloadTree, openDocument: model.openDocument, create: model.create,
    closeCreateDialog: model.closeCreateDialog,
    leaveProject: () => { void model.leaveProject().catch(error => console.error("Could not close project.", {error})); },
    openSettings: () => { void model.openSettings().catch(error => console.error("Could not open settings.", {error})); },
  };
}

const EditorContext = createContext<ReturnType<typeof useEditorModel> | null>(null);

/** 当前功能包内部共享视图数据；跨插件项目身份由 SDK 的 workbenchKey 提供。 */
export function useEditorContext() {
  const model = useContext(EditorContext);
  if (!model) throw new Error("Editor contents require an editor project context.");
  return model;
}

export function EditorContentProvider({workbench, models, children}: {
  workbench: WorkbenchService;
  models: ReadonlyMap<string, EditorModel>;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const model = state.session && models.get(state.session.id);
  return model ? <EditorModelProvider model={model} workbench={workbench}>{children}</EditorModelProvider> : null;
}

function EditorModelProvider({model, workbench, children}: {model: EditorModel; workbench: WorkbenchService; children: ReactNode}) {
  const value = useEditorModel(model, workbench);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

/** 只挂在 main 内容内，避免多个贡献重复安装快捷键。 */
export function EditorInteractions({active}: {active: boolean}) {
  const editor = useEditorContext();
  const menus = useContextMenus();
  useEffect(() => {
    menus.closeAll();
    if (!active || editor.busy) return;
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.isComposing) {
        event.preventDefault();
        void editor.workspace.saveAll();
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [active, editor.busy, editor.workspace.saveAll, menus]);
  return null;
}
