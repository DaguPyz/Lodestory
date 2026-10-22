import {useEffect, useLayoutEffect, useRef, useState} from "react";
import Quill from "quill";
import type {EditorFormat, EditorProps} from "@lodestory/sdk/body-editor";
import {createRichTextEditorSession, type RichTextEditorDriver} from "./createRichTextEditorSession";
import {createRichDeltaFromPlainText, parseRichDeltaEnvelope, serializeRichDelta, type RichDeltaOperation} from "./richDeltaFormat";
import {createPlainTextPasteDelta} from "./plainTextPaste";
import {createRichTextRegistry} from "./quillRichTextRegistry";
import {createQuillSelectControls, type QuillSelectControls} from "./quillSelectControls";
import "./rich-text-editor.css";

type Session = ReturnType<typeof createRichTextEditorSession>;
type RichTextEditorProps = EditorProps & {loadFontFamilies: () => Promise<readonly string[]>};
type QuillEditorDriver = RichTextEditorDriver & {
  setFontFamilies(families: readonly string[]): void;
};

export default function RichTextEditor(props: RichTextEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const session = useRef<Session | null>(null);
  const activeDriver = useRef<QuillEditorDriver | null>(null);
  const fontFamilies = useRef<readonly string[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const [fontError, setFontError] = useState<string>();
  const [fontRetry, setFontRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState<string>();
  const conversionLock = useRef(false);
  const conversionRequest = useRef(0);
  const conversionDocumentId = useRef<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      conversionRequest.current += 1;
      conversionLock.current = false;
      conversionDocumentId.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    session.current?.update({
      content: props.content,
      format: props.format,
      readOnly: props.readOnly || converting,
      active: props.active,
    });
  }, [props.content, props.format, props.readOnly, props.active, converting]);

  useEffect(() => {
    if (props.format !== "rich-delta") return;
    let cancelled = false;
    fontFamilies.current = [];
    activeDriver.current?.setFontFamilies([]);
    setFontLoading(true);
    setFontError(undefined);
    void Promise.resolve().then(() => props.loadFontFamilies()).then(families => {
      if (cancelled) return;
      fontFamilies.current = families;
      activeDriver.current?.setFontFamilies(families);
      if (families.length === 0) setFontError("未读取到可用的系统字体。");
    }).catch(() => {
      if (!cancelled) setFontError("无法读取系统字体，请重试。");
    }).finally(() => {
      if (!cancelled) setFontLoading(false);
    });
    return () => { cancelled = true; };
  }, [props.loadFontFamilies, props.format, fontRetry]);

  useEffect(() => {
    if (!root.current) return;
    if (conversionDocumentId.current !== null && conversionDocumentId.current !== props.documentId) {
      conversionRequest.current += 1;
      conversionLock.current = false;
      conversionDocumentId.current = null;
      setConverting(false);
      setConversionError(undefined);
    }
    let disposed = false;
    let instance: Session | undefined;
    let driver: QuillEditorDriver | undefined;
    const mount = document.createElement("div");
    mount.className = "rich-text-editor-mount";
    const editorRoot = document.createElement("div");
    editorRoot.className = "rich-text-editor-quill-root";
    mount.append(editorRoot);
    root.current.append(mount);
    setReady(false);

    try {
      if (current.current.format !== "plain-text" && current.current.format !== "rich-delta") {
        throw new Error("Quill 编辑器不支持该文档格式。");
      }
      const initial = current.current;
      driver = createQuillDriver(editorRoot, initial.content, initial.format);
      driver.setFontFamilies(fontFamilies.current);
      activeDriver.current = driver;
      instance = createRichTextEditorSession(driver, {
        content: initial.content,
        format: initial.format,
        readOnly: initial.readOnly || conversionLock.current,
        active: initial.active,
      }, {
        onChange: content => current.current.onChange(content),
        onReady: handle => {
          if (!disposed) setReady(handle !== null);
          current.current.onReady(handle);
        },
        onError: error => {
          if (!disposed) current.current.onError(error);
        },
      });
      session.current = instance;
      void instance.start();
    } catch (error) {
      if (!disposed) current.current.onError(asError(error));
    }

    return () => {
      disposed = true;
      if (activeDriver.current === driver) activeDriver.current = null;
      if (session.current === instance) session.current = null;
      if (instance) void instance.dispose().catch(error => console.error("Quill editor cleanup failed", error));
      mount.remove();
    };
  }, [props.documentId, props.format]);

  async function convertToRichText() {
    if (conversionLock.current || !current.current.onSaveAs || current.current.format !== "plain-text"
      || current.current.readOnly || !current.current.active || !session.current) return;
    conversionLock.current = true;
    const request = ++conversionRequest.current;
    const documentId = current.current.documentId;
    conversionDocumentId.current = documentId;
    setConverting(true);
    setConversionError(undefined);
    try {
      const plainText = session.current.getContent();
      session.current.update({
        content: current.current.content,
        format: current.current.format,
        readOnly: true,
        active: current.current.active,
      });
      const content = createRichDeltaFromPlainText(plainText);
      await current.current.onSaveAs({extension: "lode", content});
    } catch (error) {
      if (mounted.current && conversionRequest.current === request && current.current.documentId === documentId) {
        setConversionError(asError(error).message || "转换富文本文档失败。");
      }
    } finally {
      if (conversionRequest.current === request) {
        conversionLock.current = false;
        conversionDocumentId.current = null;
        if (mounted.current) setConverting(false);
      }
    }
  }

  return <div className="rich-text-editor" aria-busy={!ready || converting}>
    {props.format === "plain-text" && props.onSaveAs && <div className="rich-text-editor-actions">
      <button type="button" className="rich-text-editor-convert" onClick={convertToRichText}
        disabled={!ready || converting || props.readOnly || !props.active}>
        {converting ? "正在转换…" : "转换为富文本文档"}
      </button>
    </div>}
    {conversionError && <p className="rich-text-editor-error" role="alert">{conversionError}</p>}
    {props.format === "rich-delta" && fontLoading &&
      <p className="rich-text-editor-loading" role="status">正在读取系统字体…</p>}
    {props.format === "rich-delta" && fontError && <div className="rich-text-editor-font-error" role="status">
      <span>{fontError}</span>
      <button type="button" onClick={() => setFontRetry(value => value + 1)} disabled={fontLoading}>重试</button>
    </div>}
    {!ready && <p className="rich-text-editor-loading" role="status">正在准备富文本编辑器…</p>}
    <div ref={root} className="rich-text-editor-root" />
  </div>;
}

function createQuillDriver(root: HTMLElement, initialContent: string, format: EditorFormat): QuillEditorDriver {
  let quill: Quill | undefined;
  let notify: (() => void) | undefined;
  let changeHandler: ((delta: unknown, oldDelta: unknown, source: string) => void) | undefined;
  let pasteHandler: ((event: ClipboardEvent) => void) | undefined;
  let disposed = false;
  let selectControls: QuillSelectControls | undefined;
  let families: readonly string[] = [];
  let readOnly = true;

  return {
    async create() {
      const initialOps = format === "rich-delta"
        ? parseRichDeltaEnvelope(initialContent).ops
        : undefined;
      if (disposed) return;
      const instance = new Quill(root, {
        ...(format === "rich-delta" ? {theme: "snow", registry: createRichTextRegistry()} : {formats: []}),
        placeholder: "开始输入正文…",
        readOnly: true,
        modules: format === "rich-delta" ? {
          toolbar: [
            [{header: [1, 2, 3, false]}],
            [{size: [false, "10px", "12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px", "36px", "48px", "64px", "72px"]}],
            ["bold", "italic", "underline", "strike"],
            [{color: []}, {background: []}],
            [{align: ""}, {align: "center"}, {align: "right"}, {align: "justify"}],
            [{list: "ordered"}, {list: "bullet"}],
            ["blockquote", "link"],
            ["clean"],
          ],
          history: {userOnly: true},
        } : {toolbar: false, history: {userOnly: true}},
      });
      quill = instance;
      try {
        instance.root.setAttribute("role", "textbox");
        instance.root.setAttribute("aria-label", format === "plain-text" ? "纯文本正文" : "富文本正文");
        instance.root.setAttribute("aria-multiline", "true");
        if (format === "rich-delta") {
          instance.setContents(initialOps as Parameters<typeof instance.setContents>[0], "silent");
        } else {
          // Quill owns one terminal newline; the extra newline preserves any newline in the source text.
          instance.setText(`${initialContent}\n`, "silent");
          pasteHandler = event => {
            if (disposed || !quill) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!event.clipboardData) return;
            const text = event.clipboardData.getData("text/plain");
            if (text.length === 0) return;
            const selection = quill.getSelection(true);
            if (!selection) return;
            const paste = createPlainTextPasteDelta(selection, text);
            if (!paste) return;
            quill.updateContents({ops: paste.ops} as unknown as Parameters<Quill["updateContents"]>[0], "user");
            quill.setSelection(paste.cursorIndex, 0, "silent");
          };
          instance.root.addEventListener("paste", pasteHandler, true);
        }
        clearHistory(instance);
        changeHandler = (_delta: unknown, _old: unknown, source: string) => {
          if (!disposed && source === "user") notify?.();
        };
        instance.on("text-change", changeHandler);
        if (format === "rich-delta") {
          const toolbar = getToolbarContainer(instance);
          if (toolbar) {
            selectControls = createQuillSelectControls(instance, toolbar);
            selectControls.setFamilies(families);
            selectControls.setReadOnly(readOnly);
            prepareToolbar(toolbar);
          }
        }
      } catch (error) {
        selectControls?.destroy();
        selectControls = undefined;
        if (changeHandler) instance.off("text-change", changeHandler);
        if (pasteHandler) instance.root.removeEventListener("paste", pasteHandler, true);
        instance.disable();
        instance.blur();
        root.replaceChildren();
        quill = undefined;
        throw error;
      }
    },
    async destroy() {
      disposed = true;
      notify = undefined;
      selectControls?.destroy();
      selectControls = undefined;
      const instance = quill;
      quill = undefined;
      if (!instance) return;
      if (changeHandler) instance.off("text-change", changeHandler);
      if (pasteHandler) instance.root.removeEventListener("paste", pasteHandler, true);
      instance.disable();
      instance.blur();
    },
    getContent() {
      if (!quill) throw new Error("Quill 编辑器尚未创建。");
      if (format === "plain-text") {
        const text = quill.getText();
        return text.endsWith("\n") ? text.slice(0, -1) : text;
      }
      return serializeRichDelta(quill.getContents().ops as unknown as readonly RichDeltaOperation[]);
    },
    replaceContent(content, nextFormat) {
      if (!quill || nextFormat !== format) throw new Error("不能在当前 Quill 编辑器中切换文档格式。");
      if (format === "plain-text") {
        quill.setText(`${content}\n`, "silent");
      } else {
        const envelope = parseRichDeltaEnvelope(content);
        quill.setContents(envelope.ops as Parameters<typeof quill.setContents>[0], "silent");
      }
      clearHistory(quill);
    },
    setReadOnly(value) {
      readOnly = value;
      quill?.enable(!value);
      quill?.root.setAttribute("aria-readonly", String(value));
      const toolbar = quill ? getToolbarContainer(quill) : undefined;
      if (toolbar) {
        toolbar.inert = value;
        toolbar.setAttribute("aria-disabled", String(value));
        toolbar.querySelectorAll<HTMLButtonElement>(".rich-text-toolbar-actions button")
          .forEach(control => { control.disabled = value; });
      }
      selectControls?.setReadOnly(value);
    },
    setFontFamilies(value) {
      if (disposed) return;
      families = value;
      selectControls?.setFamilies(value);
    },
    focus() {
      quill?.focus();
    },
    listen(listener) {
      notify = listener;
    },
  };
}

function getToolbarContainer(quill: Quill): HTMLElement | undefined {
  const toolbar = quill.getModule("toolbar") as {container?: HTMLElement} | undefined;
  return toolbar?.container;
}

function prepareToolbar(root: HTMLElement): void {
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "富文本格式工具栏");
  root.dataset.uiDensity = "compact";
  for (const group of Array.from(root.children)) {
    group.classList.add(group.classList.contains("rich-text-select-field")
      ? "rich-text-toolbar-field" : "rich-text-toolbar-actions");
  }

  const createRow = () => {
    const row = document.createElement("div");
    row.className = "rich-text-toolbar-row";
    return row;
  };
  const appendGroup = (row: HTMLElement, selector: string) => {
    const group = root.querySelector(selector)?.closest(".ql-formats");
    if (group) row.append(group);
  };
  const fontRow = createRow();
  appendGroup(fontRow, ".rich-text-font-family");
  for (const format of ["header", "size"]) {
    appendGroup(fontRow, `[data-format="${format}"]`);
  }
  const inlineRow = createRow();
  inlineRow.classList.add("rich-text-toolbar-inline");
  appendGroup(inlineRow, ".ql-bold");
  appendGroup(inlineRow, '[data-format="color"]');

  const tools = document.createElement("span");
  tools.className = "ql-formats rich-text-toolbar-actions";
  for (const selector of [".ql-link", ".ql-clean"]) {
    const button = root.querySelector(selector);
    if (button) tools.append(button);
  }
  inlineRow.append(tools);

  const listRow = createRow();
  appendGroup(listRow, ".ql-list");
  appendGroup(listRow, ".ql-blockquote");
  const paragraphRow = createRow();
  appendGroup(paragraphRow, ".ql-align");

  const textSection = document.createElement("div");
  textSection.className = "rich-text-toolbar-section rich-text-toolbar-text";
  textSection.append(fontRow, inlineRow);
  const paragraphSection = document.createElement("div");
  paragraphSection.className = "rich-text-toolbar-section rich-text-toolbar-paragraph";
  paragraphSection.append(listRow, paragraphRow);
  root.replaceChildren(textSection, paragraphSection);

  const labels: Record<string, string> = {
    "ql-bold": "加粗",
    "ql-italic": "斜体",
    "ql-underline": "下划线",
    "ql-strike": "删除线",
    "ql-list[value=ordered]": "有序列表",
    "ql-list[value=bullet]": "无序列表",
    'ql-align[value=""]': "左对齐",
    "ql-align[value=center]": "居中对齐",
    "ql-align[value=right]": "右对齐",
    "ql-align[value=justify]": "两端对齐",
    "ql-blockquote": "引用",
    "ql-link": "插入链接",
    "ql-clean": "清除格式",
  };
  for (const [selector, label] of Object.entries(labels)) {
    root.querySelectorAll<HTMLElement>(`.${selector}`).forEach(element => {
      element.setAttribute("aria-label", label);
      if (element.tagName === "BUTTON") element.title = label;
    });
  }
}

function clearHistory(quill: Quill) {
  const history = quill.getModule("history") as {clear?: () => void} | undefined;
  history?.clear?.();
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
