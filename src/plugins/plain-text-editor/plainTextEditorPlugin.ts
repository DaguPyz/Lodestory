import {createElement} from "react";
import type {EditorProps} from "@lodestory/sdk/body-editor";
import {i18nKey} from "@lodestory/sdk/i18n";
import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey} from "@lodestory/sdk/body-editor";

/** Registers the built-in editor dedicated to ordinary TXT documents. */
export function createPlainTextEditorPlugin(): Plugin {
  let removeEditor: (() => void) | undefined;

  return {
    id: "plain-text-editor",
    requires: [bodyEditorKey, i18nKey],
    provides: [],
    activate(context) {
      const bodyEditor = context.get(bodyEditorKey);
      const i18n = context.get(i18nKey);
      removeEditor = context.track(bodyEditor.registerEditor({
        id: "plain-text",
        formats: ["plain-text"],
        getText(content, format) {
          if (format !== "plain-text") throw new Error("TXT 编辑器无法读取此文档格式。");
          return content;
        },
        async load() {
          const {default: Editor} = await import("./PlainTextEditor");
          return {default: (props: EditorProps) => createElement(Editor, {...props, i18n})};
        },
      }));
    },
    deactivate() {
      const remove = removeEditor;
      removeEditor = undefined;
      remove?.();
    },
  };
}
