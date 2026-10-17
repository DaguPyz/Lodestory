import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {ReferencePanel} from "./ReferencePanel";
import {editorContentIds} from "./editorContentIds";
import "./editor.css";

/** 暂留的参考资料占位；正文和工具栏均由独立插件提供。 */
export function createEditorFeaturesPlugin(): Plugin {
  const removeContents: (() => void)[] = [];
  return {
    id: "editor-features",
    requires: [layoutKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      removeContents.push(layout.registerContent({
        id: editorContentIds.auxiliary, title: "参考资料", role: "auxiliary", render: () => <ReferencePanel/>,
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
