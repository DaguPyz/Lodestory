import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey} from "@lodestory/sdk/body-editor";

/** Registers Milkdown Crepe as the Markdown body editor implementation. */
export function createMarkdownEditorPlugin(): Plugin {
  let removeEditor: (() => void) | undefined;

  return {
    id: "markdown-editor",
    requires: [bodyEditorKey],
    provides: [],
    activate(context) {
      const bodyEditor = context.get(bodyEditorKey);
      removeEditor = bodyEditor.registerEditor({
        id: "milkdown",
        formats: ["markdown"],
        load: () => import("./MarkdownEditor"),
      });
    },
    deactivate() {
      const remove = removeEditor;
      removeEditor = undefined;
      remove?.();
    },
  };
}
