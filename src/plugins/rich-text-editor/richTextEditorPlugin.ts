import {createElement, type ComponentType} from "react";
import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey, type EditorProps} from "@lodestory/sdk/body-editor";
import {getRichEditorText} from "./richDeltaFormat";
import {createSystemFontLoader} from "./systemFonts";

/** Registers Quill as the plain-text and versioned rich-delta body editor. */
export function createRichTextEditorPlugin(): Plugin {
  let removeEditor: (() => void) | undefined;

  return {
    id: "rich-text-editor",
    requires: [bodyEditorKey],
    provides: [],
    activate(context) {
      const bodyEditor = context.get(bodyEditorKey);
      const loadFontFamilies = createSystemFontLoader();
      removeEditor = bodyEditor.registerEditor({
        id: "quill",
        formats: ["plain-text", "rich-delta"],
        getText(content, format) {
          const text = getRichEditorText(content, format);
          if (text === undefined) throw new Error("Quill 无法读取此文档的纯文本内容。");
          return text;
        },
        load: async () => {
          const module = await import("./RichTextEditor");
          const EditorWithSystemFonts: ComponentType<EditorProps> = props =>
            createElement(module.default, {...props, loadFontFamilies});
          return {default: EditorWithSystemFonts};
        },
      });
    },
    deactivate() {
      const remove = removeEditor;
      removeEditor = undefined;
      remove?.();
    },
  };
}
