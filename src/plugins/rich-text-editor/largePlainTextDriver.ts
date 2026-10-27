import {Compartment, EditorSelection, EditorState, Transaction, type Extension} from "@codemirror/state";
import {deleteCharBackwardStrict, history, historyKeymap, insertNewline, isolateHistory, standardKeymap} from "@codemirror/commands";
import {search, searchKeymap} from "@codemirror/search";
import {EditorView, keymap} from "@codemirror/view";
import type {RichTextEditorDriver} from "./createRichTextEditorSession";

const historyCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

function normalizedText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function readOnlyExtensions(readOnly: boolean): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorState.transactionFilter.of(transaction =>
      readOnly && transaction.docChanged && transaction.annotation(Transaction.userEvent) !== undefined
        ? []
        : transaction),
  ];
}

function boundedSelection(state: EditorState, length: number) {
  const ranges = state.selection.ranges.map(range => EditorSelection.range(
    Math.min(range.anchor, length),
    Math.min(range.head, length),
  ));
  const mainIndex = Math.min(state.selection.mainIndex, Math.max(0, ranges.length - 1));
  return EditorSelection.create(ranges, mainIndex);
}

function insertLiteralTab(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.update(view.state.replaceSelection("\t"), {
    scrollIntoView: true, userEvent: "input", annotations: isolateHistory.of("full"),
  }));
  return true;
}

function removePrecedingTab(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (view.state.readOnly || !selection.empty || selection.from === 0
    || view.state.sliceDoc(selection.from - 1, selection.from) !== "\t") return false;
  view.dispatch({changes: {from: selection.from - 1, to: selection.from}, userEvent: "delete.backward"});
  return true;
}

/**
 * Creates the plain-text CodeMirror state. CodeMirror renders only its viewport and a small
 * margin around it; the full source remains in the document model for persistence.
 */
export function createLargePlainTextState(
  content: string,
  readOnly = true,
  onDocumentChange?: () => void,
): EditorState {
  return EditorState.create({
    doc: normalizedText(content),
    extensions: [
      historyCompartment.of(history()),
      readOnlyCompartment.of(readOnlyExtensions(readOnly)),
      EditorView.lineWrapping,
      EditorState.phrases.of({
        Find: "查找", Replace: "替换", next: "下一个", previous: "上一个", all: "全部",
        "match case": "区分大小写", regexp: "正则表达式", "by word": "全词匹配",
        replace: "替换", "replace all": "全部替换", close: "关闭", "No matches found": "未找到匹配项",
      }),
      EditorView.contentAttributes.of({
        "aria-label": "纯文本正文",
        spellcheck: "false",
      }),
      ...(onDocumentChange ? [EditorView.updateListener.of(update => {
        if (update.docChanged) onDocumentChange();
      })] : []),
      search(),
      keymap.of([
        {key: "Enter", run: insertNewline, shift: insertNewline},
        {key: "Tab", run: insertLiteralTab, shift: removePrecedingTab},
        {key: "Backspace", run: deleteCharBackwardStrict, shift: deleteCharBackwardStrict},
        {mac: "Ctrl-h", run: deleteCharBackwardStrict},
        ...historyKeymap, ...standardKeymap, ...searchKeymap,
      ]),
      EditorView.domEventHandlers({
        paste(event, view) {
          const clipboard = event.clipboardData;
          if (!clipboard) return false;
          event.preventDefault();
          const text = normalizedText(clipboard.getData("text/plain"));
          if (text.length === 0) return true;
          const selection = view.state.selection.main;
          view.dispatch({
            changes: {from: selection.from, to: selection.to, insert: text},
            selection: {anchor: selection.from + text.length},
            userEvent: "input.paste",
            scrollIntoView: true,
          });
          return true;
        },
      }),
    ],
  });
}

/** Replaces the source without creating undo history and keeps a clamped selection. */
function replacementTransaction(state: EditorState, content: string) {
  const doc = normalizedText(content);
  return state.update({
    changes: {from: 0, to: state.doc.length, insert: doc},
    selection: boundedSelection(state, doc.length),
    effects: historyCompartment.reconfigure([]),
  });
}

export function replaceLargePlainTextState(state: EditorState, content: string): EditorState {
  const replaced = replacementTransaction(state, content).state;
  return replaced.update({effects: historyCompartment.reconfigure(history())}).state;
}

/** The plain-text driver uses CodeMirror's virtual viewport and emits complete source strings. */
export function createLargePlainTextDriver(root: HTMLElement, initialContent: string): RichTextEditorDriver {
  let view: EditorView | undefined;
  let listener: (() => void) | undefined;
  let readOnly = true;
  let destroyed = false;
  let suppressChangeNotification = false;
  let addedRootClass = false;

  return {
    async create() {
      if (view || destroyed) return;
      addedRootClass = !root.classList.contains("large-plain-text-editor");
      root.classList.add("large-plain-text-editor");
      try {
        view = new EditorView({
          state: createLargePlainTextState(initialContent, readOnly, () => {
            if (!destroyed && !suppressChangeNotification) listener?.();
          }),
          parent: root,
        });
      } catch (error) {
        root.replaceChildren();
        if (addedRootClass) root.classList.remove("large-plain-text-editor");
        addedRootClass = false;
        throw error;
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      listener = undefined;
      const current = view;
      view = undefined;
      current?.destroy();
      root.replaceChildren();
      if (addedRootClass) root.classList.remove("large-plain-text-editor");
      addedRootClass = false;
    },
    getContent() {
      if (!view || destroyed) throw new Error("CodeMirror 纯文本编辑器尚未创建。");
      return view.state.doc.toString();
    },
    replaceContent(content, format) {
      if (format !== "plain-text") throw new Error("CodeMirror 纯文本编辑器不能切换文档格式。");
      if (destroyed) return;
      if (!view) throw new Error("CodeMirror 纯文本编辑器尚未创建。");
      suppressChangeNotification = true;
      try {
        // Keep view plugins (including a focused search panel) alive during external replacement.
        view.dispatch(replacementTransaction(view.state, content));
        view.dispatch({effects: historyCompartment.reconfigure(history())});
      }
      finally { suppressChangeNotification = false; }
    },
    setReadOnly(value) {
      readOnly = value;
      if (!view || destroyed || view.state.facet(EditorState.readOnly) === value) return;
      view.dispatch({effects: readOnlyCompartment.reconfigure(readOnlyExtensions(value))});
    },
    focus() {
      if (!destroyed) view?.focus();
    },
    listen(next) {
      listener = destroyed ? undefined : next;
    },
  };
}
