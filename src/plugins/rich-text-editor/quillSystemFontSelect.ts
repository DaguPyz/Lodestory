import type Quill from "quill";
import {isRichFontFamily} from "./richTextFormatting";

export type SystemFontSelect = Readonly<{
  setFamilies(families: readonly string[]): void;
  setReadOnly(value: boolean): void;
  destroy(): void;
}>;

/** A native select keeps large system font lists out of Snow's generated picker. */
export function createSystemFontSelect(quill: Quill, toolbar: HTMLElement): SystemFontSelect {
  const group = document.createElement("label");
  group.className = "ql-formats rich-text-font-family";
  const caption = document.createElement("span");
  caption.className = "rich-text-toolbar-caption";
  caption.textContent = "字体";
  const select = document.createElement("select");
  select.className = "rich-text-font-select";
  select.setAttribute("aria-label", "字体");
  group.append(caption, select);
  toolbar.prepend(group);

  let families: readonly string[] = [];
  let readOnly = true;
  let disposed = false;
  let lastRange = {index: 0, length: 0};
  let documentFont: string | undefined;

  function selectedRange() {
    const range = quill.getSelection() ?? lastRange;
    const end = Math.max(0, quill.getLength() - 1);
    const index = Math.min(Math.max(0, range.index), end);
    return {index, length: Math.min(Math.max(0, range.length), end - index)};
  }

  function renderOptions() {
    const options = [new Option("默认字体", "")];
    if (documentFont && !families.includes(documentFont)) {
      options.push(new Option(`${documentFont}（文档字体）`, documentFont));
    }
    for (const family of families) options.push(new Option(family, family));
    select.replaceChildren(...options);
    select.value = documentFont ?? "";
    select.disabled = readOnly || families.length === 0;
  }

  function syncSelection() {
    if (disposed) return;
    const font: unknown = quill.getFormat(selectedRange()).font;
    const next = isRichFontFamily(font) ? font : undefined;
    if (next !== documentFont) {
      documentFont = next;
      renderOptions();
    }
  }

  const onEditorChange = (event: string, ...args: unknown[]) => {
    const range = args[0];
    if (event === "selection-change" && range && typeof range === "object"
      && "index" in range && typeof range.index === "number"
      && "length" in range && typeof range.length === "number") {
      lastRange = {index: range.index, length: range.length};
    }
    syncSelection();
  };
  const onChange = () => {
    if (disposed || readOnly || !quill.isEnabled()) return;
    const range = selectedRange();
    quill.setSelection(range.index, range.length, "silent");
    quill.format("font", select.value || false, "user");
    quill.focus();
    syncSelection();
  };
  select.addEventListener("change", onChange);
  quill.on("editor-change", onEditorChange);
  renderOptions();
  syncSelection();

  return {
    setFamilies(next) {
      if (disposed) return;
      families = [...new Set(next.filter(isRichFontFamily))];
      renderOptions();
      syncSelection();
    },
    setReadOnly(value) {
      readOnly = value;
      select.disabled = value || families.length === 0;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener("change", onChange);
      quill.off("editor-change", onEditorChange);
      group.remove();
    },
  };
}
