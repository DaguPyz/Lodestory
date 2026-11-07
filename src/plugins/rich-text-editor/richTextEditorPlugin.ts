import {createElement, type ComponentType} from "react";
import type {Plugin} from "@lodestory/sdk";
import {bodyEditorKey, type EditorProps} from "@lodestory/sdk/body-editor";
import {uiInteractionKey} from "@lodestory/sdk/ui";
import {createRichDeltaFromPlainText, getRichEditorText} from "./richDeltaFormat";
import {createSystemFontLoader} from "./systemFonts";

/** Registers Quill as the versioned rich-delta body editor and contributes TXT conversion. */
export function createRichTextEditorPlugin(): Plugin {
  let removeEditor: (() => void) | undefined;

  return {
    id: "rich-text-editor",
    requires: [bodyEditorKey, uiInteractionKey],
    provides: [],
    activate(context) {
      const bodyEditor = context.get(bodyEditorKey);
      const interaction = context.get(uiInteractionKey);
      const loadFontFamilies = createSystemFontLoader();
      removeEditor = context.track(bodyEditor.registerEditor({
        id: "quill",
        formats: ["rich-delta"],
        scrollMode: "editor",
        conversions: [{
          id: "convert-to-rich-text",
          label: "转换为富文本文档",
          from: "plain-text",
          extension: "lode",
          convert: createRichDeltaFromPlainText,
        }],
        getText(content, format) {
          const text = getRichEditorText(content, format);
          if (text === undefined) throw new Error("Quill 无法读取此文档的纯文本内容。");
          return text;
        },
        async getSearchText(content, format, signal) {
          if (format !== "rich-delta") throw new Error("Quill 无法搜索此文档格式。");
          return (await import("./richSearchClient")).extractRichSearchText(content, signal);
        },
        load: async () => {
          const module = await import("./RichTextEditor");
          const EditorWithSystemFonts: ComponentType<EditorProps> = props =>
            createElement(module.default, {...props, loadFontFamilies, interaction});
          return {default: EditorWithSystemFonts};
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
