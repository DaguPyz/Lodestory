import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {EditorProps} from "@lodestory/sdk/body-editor";
import {Crepe} from "@milkdown/crepe";
import {EditorStatus, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx} from "@milkdown/kit/core";
import {Plugin, TextSelection} from "@milkdown/kit/prose/state";
import type {EditorView} from "@milkdown/kit/prose/view";
import {uploadConfig} from "@milkdown/kit/plugin/upload";
import {$prose} from "@milkdown/kit/utils";
import {createMarkdownEditorSession, type MarkdownEditorDriver} from "./createMarkdownEditorSession";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./markdown-editor.css";

type Session = ReturnType<typeof createMarkdownEditorSession>;

export default function MarkdownEditor(props: EditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const session = useRef<Session | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    session.current?.update({content: props.content, readOnly: props.readOnly, active: props.active});
  }, [props.content, props.readOnly, props.active]);

  useEffect(() => {
    if (!root.current) return;
    let disposed = false;
    let instance: Session | undefined;
    // A separate mount keeps a late StrictMode cleanup away from the next editor.
    const mount = document.createElement("div");
    root.current.append(mount);
    setReady(false);
    const report = (reason: unknown) => {
      if (!disposed) current.current.onError(asError(reason));
    };
    try {
      if (current.current.format !== "markdown") throw new Error("Markdown 编辑器不支持该文档格式。");
      const initial = current.current;
      const driver = createMilkdownDriver(mount, initial.content, report);
      instance = createMarkdownEditorSession(driver, initial, {
        onChange: content => current.current.onChange(content),
        onReady: handle => {
          if (!disposed) setReady(handle !== null);
          current.current.onReady(handle);
        },
        onError: report,
      });
      session.current = instance;
      void instance.start();
    } catch (error) {
      report(error);
    }
    return () => {
      disposed = true;
      if (session.current === instance) session.current = null;
      mount.remove();
      if (instance) void instance.dispose().catch(error => console.error("Markdown editor cleanup failed", error));
    };
  }, [props.documentId, props.format]);

  return <div className="markdown-editor" aria-busy={!ready}>
    {!ready && <p className="editor-document-feedback" role="status">正在准备 Markdown 编辑器…</p>}
    <div ref={root}/>
  </div>;
}

function createMilkdownDriver(root: HTMLElement, content: string, onError: (reason: unknown) => void): MarkdownEditorDriver {
  let notify: (markdown: string) => void = () => undefined;
  let readOnly = true;
  let creationFailed = false;
  let disposed = false;
  let mountedView: EditorView | undefined;
  const crepe = new Crepe({
    root,
    defaultValue: content,
    features: {[Crepe.Feature.ImageBlock]: false},
    featureConfigs: {
      [Crepe.Feature.Placeholder]: {text: "开始写作，输入 / 插入内容…"},
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: "正文", text: {label: "段落"},
          h1: {label: "一级标题"}, h2: {label: "二级标题"}, h3: {label: "三级标题"},
          h4: {label: "四级标题"}, h5: {label: "五级标题"}, h6: {label: "六级标题"},
          quote: {label: "引用"}, divider: {label: "分隔线"},
        },
        listGroup: {label: "列表", bulletList: {label: "无序列表"}, orderedList: {label: "有序列表"}, taskList: {label: "任务列表"}},
        advancedGroup: {label: "插入", codeBlock: {label: "代码块"}, table: {label: "表格"}, math: {label: "公式"}},
      },
    },
  });
  crepe.editor.config(ctx => {
    ctx.update(editorViewOptionsCtx, options => ({
      ...options,
      attributes: state => ({
        ...(typeof options.attributes === "function" ? options.attributes(state) : options.attributes),
        role: "textbox", "aria-label": "Markdown 正文", "aria-multiline": "true", "aria-readonly": String(readOnly),
      }),
    }));
    // Disable local uploads until workspace attachment storage is available.
    ctx.update(uploadConfig.key, options => ({...options, uploader: async () => [], enableHtmlFileUploader: false}));
  });
  crepe.editor.use($prose(ctx => new Plugin({
    view: view => {
      mountedView = view;
      if (disposed) queueMicrotask(() => { if (!view.isDestroyed) view.destroy(); });
      return {
        update(view, previous) {
          if (disposed || view.state.doc.eq(previous.doc)) return;
          try { notify(ctx.get(serializerCtx)(view.state.doc)); }
          catch (error) { onError(error); }
        },
      };
    },
  })));
  crepe.setReadonly(true);

  return {
    async create() {
      try { await crepe.create(); }
      catch (error) { creationFailed = true; throw error; }
    },
    async destroy() {
      disposed = true;
      notify = () => undefined;
      // Milkdown leaves a rejected create in OnCreate; destroy would poll forever.
      if (creationFailed && crepe.editor.status === EditorStatus.OnCreate) {
        if (mountedView && !mountedView.isDestroyed) mountedView.destroy();
      } else {
        await crepe.destroy();
      }
      mountedView = undefined;
    },
    getMarkdown: () => crepe.getMarkdown(),
    replaceMarkdown(markdown) {
      crepe.editor.action(ctx => {
        const doc = ctx.get(parserCtx)(markdown);
        if (!doc) throw new Error("无法解析 Markdown 内容。");
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta("addToHistory", false));
      });
    },
    setReadOnly(value) {
      readOnly = value;
      crepe.setReadonly(value);
    },
    focus: () => crepe.editor.action(ctx => ctx.get(editorViewCtx).focus()),
    revealSearchRange(target) {
      return crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        let text = "";
        const positions: number[] = [];
        let hasBlock = false;
        view.state.doc.descendants((node, position) => {
          if (!node.isTextblock) return true;
          if (hasBlock) { text += "\n"; positions.push(position); }
          hasBlock = true;
          node.descendants((child, offset) => {
            if (child.isText && child.text) {
              for (let index = 0; index < child.text.length; index++) positions.push(position + 1 + offset + index);
              text += child.text;
            } else if (child.type.name === "hardbreak") { text += "\n"; positions.push(position + 1 + offset); }
          });
          return false;
        });
        // The editor can append an empty paragraph after a table for typing.
        if (text === `${target.text}\n`) { text = text.slice(0, -1); positions.pop(); }
        if (text !== target.text) return false;
        if (target.start < 0 || target.end <= target.start || target.end > text.length) return false;
        const from = positions[target.start], to = positions[target.end - 1] + 1;
        if (from === undefined || !Number.isFinite(to)) return false;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).scrollIntoView());
        view.focus();
        return true;
      });
    },
    listen: listener => { notify = listener; },
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
