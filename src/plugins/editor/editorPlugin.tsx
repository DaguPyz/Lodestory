import type {Plugin} from "@lodestory/sdk";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {layoutKey} from "@lodestory/sdk/layout";
import {EditorActions} from "./EditorActions";
import {ReferencePanel} from "./ReferencePanel";
import {editorContentIds} from "./editorContentIds";
import "./editor.css";

/** 暂留的项目操作与参考占位；正文和文档状态已由独立插件提供。 */
export function createEditorFeaturesPlugin(): Plugin {
  const removeContents: (() => void)[] = [];
  return {
    id: "editor-features",
    requires: [workbenchKey, uiKey, layoutKey, themeKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const layout = context.get(layoutKey);
      const ui = context.get(uiKey);
      removeContents.push(layout.registerContent({
        id: editorContentIds.auxiliary, title: "参考资料", role: "auxiliary", render: () => <ReferencePanel/>,
      }));
      removeContents.push(layout.registerContent({
        id: editorContentIds.actions, title: "项目操作", role: "actions", render: props => <EditorActions workbench={workbench} ui={ui} {...props}/>,
      }));
    },
    deactivate() {
      const errors: unknown[] = [];
      for (const remove of removeContents.splice(0).reverse()) {
        try { remove(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw Object.assign(new Error("Editor features failed to stop."), {errors});
    },
  };
}
