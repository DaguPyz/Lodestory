import {createRoot, type Root} from "react-dom/client";
import {Select} from "@lodestory/ui";
import type Quill from "quill";
import {isRichFontFamily} from "./richTextFormatting";
import {
  createPickerOptions,
  createQuillSelectController,
  createSystemFontOptions,
  type QuillSelectController,
  type QuillSelectFormat,
  type QuillSelectOption,
} from "./quillSelectModel";

export type QuillSelectControls = Readonly<{
  setFamilies(families: readonly string[]): void;
  setReadOnly(value: boolean): void;
  destroy(): void;
}>;

type SelectEntry = {
  format: QuillSelectFormat;
  label: string;
  placeholder: string;
  host: HTMLElement;
  root: Root;
  baseOptions: readonly QuillSelectOption[];
  value?: string | null;
  disabled?: boolean;
};

const pickerLabels: Readonly<Record<QuillSelectFormat, string>> = {
  font: "字体",
  header: "标题级别",
  size: "字号",
  align: "段落对齐",
  color: "文字颜色",
  background: "文字背景色",
};

const pickerOrder: readonly Exclude<QuillSelectFormat, "font">[] = ["header", "size", "color", "background", "align"];

/** Replaces Snow's generated select pickers with the public shared Select while leaving action buttons to Quill. */
export function createQuillSelectControls(quill: Quill, toolbar: HTMLElement): QuillSelectControls {
  const entries: SelectEntry[] = [];
  const cleanups: Array<() => void> = [];
  const editorFocus: {current: HTMLElement | null} = {current: quill.root};
  let families: readonly string[] = [];
  let readOnly = true;
  let disposed = false;

  const controller: QuillSelectController = createQuillSelectController(quill, renderAll);

  function resolveOptions(entry: SelectEntry, value: string | null): readonly QuillSelectOption[] {
    if (entry.format === "font") {
      return createSystemFontOptions(families, value || undefined);
    }
    if (value !== null && !entry.baseOptions.some(option => option.value === value)
      && (entry.format === "color" || entry.format === "background")) {
      return [{value, label: value, swatch: value}, ...entry.baseOptions];
    }
    return entry.baseOptions;
  }

  function renderEntry(entry: SelectEntry, force = false) {
    const value = controller.getValue(entry.format);
    const disabled = readOnly || (entry.format === "font" && families.length === 0);
    if (!force && entry.value === value && entry.disabled === disabled) return;
    const options = resolveOptions(entry, value);
    entry.value = value;
    entry.disabled = disabled;
    entry.root.render(<Select value={value} options={options} onValueChange={next => controller.apply(entry.format, next)}
      placeholder={entry.placeholder} disabled={disabled} aria-label={entry.label}
      finalFocus={editorFocus} />);
  }

  function renderAll() {
    if (disposed) return;
    entries.forEach(entry => renderEntry(entry));
  }

  function mountEntry(format: QuillSelectFormat, host: HTMLElement, values: readonly string[]) {
    const root = createRoot(host);
    const entry: SelectEntry = {
      format,
      label: pickerLabels[format],
      placeholder: format === "font" ? "字体" : format === "header" ? "多种标题" : format === "size" ? "多种字号" : "多种格式",
      host,
      root,
      baseOptions: format === "font" ? createSystemFontOptions([]) : createPickerOptions(format, values),
    };
    entries.push(entry);
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });
    renderEntry(entry, true);
  }

  function replacePicker(format: Exclude<QuillSelectFormat, "font">) {
    const picker = toolbar.querySelector<HTMLElement>(`.ql-picker.ql-${format}`);
    const group = picker?.closest<HTMLElement>(".ql-formats");
    const nativeSelect = group?.querySelector<HTMLSelectElement>(`select.ql-${format}`);
    if (!picker || !group || !nativeSelect) throw new Error(`Quill 未生成 ${pickerLabels[format]} 下拉控件。`);

    const values = Array.from(nativeSelect.options, option => option.value);
    const host = document.createElement("span");
    host.className = "rich-text-select-host";
    releaseSnowPickerReferences(quill, picker, nativeSelect);
    group.classList.add("rich-text-select-field", `ql-${format}`);
    picker.replaceWith(host);
    nativeSelect.remove();
    mountEntry(format, host, values);
  }

  try {
    const fontGroup = document.createElement("span");
    fontGroup.className = "ql-formats rich-text-font-family rich-text-select-field";
    cleanups.push(() => fontGroup.remove());
    const fontHost = document.createElement("span");
    fontHost.className = "rich-text-select-host";
    fontGroup.append(fontHost);
    toolbar.prepend(fontGroup);
    mountEntry("font", fontHost, []);
    pickerOrder.forEach(replacePicker);
  } catch (error) {
    disposed = true;
    controller.destroy();
    cleanups.reverse().forEach(cleanup => cleanup());
    throw error;
  }

  return {
    setFamilies(next) {
      if (disposed) return;
      families = [...new Set(next.filter(isRichFontFamily))];
      const font = entries.find(entry => entry.format === "font");
      if (font) renderEntry(font, true);
    },
    setReadOnly(value) {
      if (disposed || readOnly === value) return;
      readOnly = value;
      controller.setReadOnly(value);
      entries.forEach(entry => renderEntry(entry));
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      cleanups.reverse().forEach(cleanup => cleanup());
      controller.destroy();
    },
  };
}

function releaseSnowPickerReferences(quill: Quill, picker: HTMLElement, nativeSelect: HTMLSelectElement): void {
  const toolbar = quill.getModule("toolbar") as {controls?: Array<[string, HTMLElement]>} | undefined;
  if (toolbar?.controls) {
    toolbar.controls = toolbar.controls.filter(([, control]) => control !== nativeSelect);
  }

  // Quill 2's BaseTheme retains generated pickers and updates them on every editor-change.
  const theme = quill.theme as typeof quill.theme & {pickers?: Array<{container: HTMLElement}>};
  if (theme.pickers) theme.pickers = theme.pickers.filter(candidate => candidate.container !== picker);
}
