import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey} from "@lodestory/sdk/body-editor";

/** Registers the built-in editor dedicated to ordinary TXT documents. */
export function createPlainTextEditorPlugin(): Plugin {
  let removeEditor: (() => void) | undefined;

  return {
    id: "plain-text-editor",
    requires: [bodyEditorKey],
    provides: [],
    activate(context) {
      const bodyEditor = context.get(bodyEditorKey);
      removeEditor = context.track(bodyEditor.registerEditor({
        id: "plain-text",
        formats: ["plain-text"],
        replaces: [{id: "quill", format: "plain-text"}],
        getText(content, format) {
          if (format !== "plain-text") throw new Error("TXT 编辑器无法读取此文档格式。");
          return content;
        },
        load: () => import("./PlainTextEditor"),
      }));
    },
    deactivate() {
      const remove = removeEditor;
      removeEditor = undefined;
      remove?.();
    },
  };
}
