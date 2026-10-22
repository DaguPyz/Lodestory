import type Quill from "quill";
import {isRichFontFamily} from "./richTextFormatting";

export type QuillSelectFormat = "font" | "header" | "size" | "align" | "color" | "background";

export type QuillSelectOption = Readonly<{
  value: string;
  label: string;
  disabled?: boolean;
  swatch?: string;
}>;

type SelectionRange = {index: number; length: number};

export type QuillSelectController = Readonly<{
  getRange(): SelectionRange;
  getValue(format: QuillSelectFormat): string | null;
  apply(format: QuillSelectFormat, value: string): boolean;
  setReadOnly(value: boolean): void;
  destroy(): void;
}>;

const formatLabels: Record<Exclude<QuillSelectFormat, "font">, (value: string) => string> = {
  header: value => value ? `标题 ${value}` : "正文",
  size: value => value || "默认字号",
  align: value => ({"": "左对齐", center: "居中对齐", right: "右对齐", justify: "两端对齐"})[value] ?? value,
  color: value => value || "默认颜色",
  background: value => value || "默认背景色",
};

export function createSystemFontOptions(families: readonly string[], documentFont?: string): QuillSelectOption[] {
  const available = [...new Set(families.filter(isRichFontFamily))];
  return [
    {value: "", label: "默认字体"},
    ...(documentFont && !available.includes(documentFont)
      ? [{value: documentFont, label: `${documentFont}（文档字体）`}]
      : []),
    ...available.map(family => ({value: family, label: family})),
  ];
}

export function createPickerOptions(format: Exclude<QuillSelectFormat, "font">, values: readonly string[]): QuillSelectOption[] {
  return values.map(value => ({
    value,
    label: formatLabels[format](value),
    ...((format === "color" || format === "background") && value ? {swatch: value} : {}),
  }));
}

function isSelectionRange(value: unknown): value is SelectionRange {
  return typeof value === "object" && value !== null
    && "index" in value && typeof value.index === "number"
    && "length" in value && typeof value.length === "number";
}

function selectValue(value: unknown): string | null {
  if (value == null || value === false) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  // Quill returns an array when the selected text has mixed formatting.
  return null;
}

/** Keeps Quill's last selection available while a shared Select owns DOM focus. */
export function createQuillSelectController(
  quill: Quill,
  onChange: () => void = () => {},
): QuillSelectController {
  let lastRange: SelectionRange = {index: 0, length: 0};
  let readOnly = true;
  let disposed = false;

  function getRange(): SelectionRange {
    const currentRange = quill.getSelection();
    if (currentRange) lastRange = currentRange;
    const range = currentRange ?? lastRange;
    const end = Math.max(0, quill.getLength() - 1);
    const index = Math.min(Math.max(0, range.index), end);
    return {index, length: Math.min(Math.max(0, range.length), end - index)};
  }

  function onEditorChange(event: string, range?: unknown) {
    if (disposed) return;
    if (event === "selection-change" && isSelectionRange(range)) lastRange = range;
    onChange();
  }

  quill.on("editor-change", onEditorChange);

  return {
    getRange,
    getValue(format) {
      return selectValue(quill.getFormat(getRange())[format]);
    },
    apply(format, value) {
      if (disposed || readOnly || !quill.isEnabled()) return false;
      const range = getRange();
      quill.setSelection(range.index, range.length, "silent");
      quill.format(format, value || false, "user");
      quill.focus();
      onChange();
      return true;
    },
    setReadOnly(value) {
      if (disposed || readOnly === value) return;
      readOnly = value;
      onChange();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      quill.off("editor-change", onEditorChange);
    },
  };
}
