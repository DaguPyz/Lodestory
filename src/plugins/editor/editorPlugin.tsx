import type {Plugin} from "@lodestory/sdk";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {layoutKey, type LayoutContent} from "@lodestory/sdk/layout";
import {EditorContentProvider} from "./EditorPage";
import {EditorActions, EditorMain, EditorNavigation, EditorStatus} from "./EditorContents";
import {ReferencePanel} from "./ReferencePanel";
import {editorContentIds} from "./editorContentIds";
import {createEditorModel, type EditorModel} from "./editorModel";

/** 当前编辑功能先统一接入工作台协议，后续可继续逐个拆成独立功能插件。 */
export function createEditorFeaturesPlugin(): Plugin {
  const models = new Map<string, EditorModel>();
  const removeContents: (() => void)[] = [];
  let removeParticipant: (() => Promise<void>) | undefined;
  return {
    id: "editor-features",
    requires: [workbenchKey, uiKey, layoutKey, themeKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const layout = context.get(layoutKey);
      const ui = context.get(uiKey);
      removeParticipant = workbench.registerParticipant({
        id: "editor-features",
        start(session) {
          const model = createEditorModel(session, workbench, layout, ui);
          models.set(session.id, model);
          return {
            beforeLeave: model.beforeLeave,
            async dispose() {
              try { await model.dispose(); }
              finally { if (models.get(session.id) === model) models.delete(session.id); }
            },
          };
        },
      });
      const contents: LayoutContent[] = [
        {id: editorContentIds.main, title: "正文编辑", role: "main", render: props => <EditorMain {...props}/>},
        {id: editorContentIds.navigation, title: "项目文件", role: "navigation", render: props => <EditorNavigation {...props}/>},
        {id: editorContentIds.auxiliary, title: "参考资料", role: "auxiliary", render: () => <ReferencePanel/>},
        {id: editorContentIds.actions, title: "项目操作", role: "actions", render: props => <EditorActions {...props}/>},
        {id: editorContentIds.status, title: "写作状态", role: "status", render: () => <EditorStatus/>},
      ];
      for (const content of contents) {
        removeContents.push(layout.registerContent({...content, render: props =>
          <EditorContentProvider workbench={workbench} models={models}>{content.render(props)}</EditorContentProvider>}));
      }
    },
    async deactivate() {
      const errors: unknown[] = [];
      for (const remove of removeContents.splice(0).reverse()) {
        try { remove(); } catch (error) { errors.push(error); }
      }
      const remove = removeParticipant;
      removeParticipant = undefined;
      try { await remove?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Editor features failed to stop."), {errors});
    },
  };
}
