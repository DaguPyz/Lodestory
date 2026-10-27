import {createRoot, type Root} from "react-dom/client";
import {EditorView} from "@codemirror/view";
import RichTextEditor from "../../src/plugins/rich-text-editor/RichTextEditor";
import type {EditorContextMenuAction, EditorHandle} from "../../packages/sdk/src/body-editor";

const initialContent = `\uFEFF${Array.from({length: 10_000}, (_, index) =>
  `line-${String(index).padStart(5, "0")}-${"x".repeat(28)}`).join("\r\n")}\r\n\r\n`;

type FixtureProps = {
  documentId: string;
  format: "plain-text";
  content: string;
  readOnly: boolean;
  active: boolean;
  loadFontFamilies: () => Promise<readonly string[]>;
  onChange(content: string): void;
  onReady(handle: EditorHandle | null): void;
  onError(error: Error): void;
  onSaveAs(request: Readonly<{extension: string; content: string}>): Promise<void>;
};

type FixtureApi = {
  snapshot(includeText?: boolean): Record<string, unknown>;
  focusAt(index: number): void;
  pasteAt(index: number, value: string): boolean;
  setProps(patch: Partial<Pick<FixtureProps, "content" | "readOnly" | "active">>): void;
  contextActions(): readonly EditorContextMenuAction[];
  runConvert(): Promise<void>;
  unmount(): void;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("The browser fixture root is missing.");
const root: Root = createRoot(app);
let props: FixtureProps;
let hostContent = initialContent;
let changeCount = 0;
let lastChangedContent: string | undefined;
let readyCount = 0;
let handle: EditorHandle | null = null;
let lastError: string | undefined;
let saveAsRequest: {extension: string; content: string} | undefined;
let editorView: EditorView | undefined;
let unmounted = false;

props = {
  documentId: "large-plain-text-regression",
  format: "plain-text",
  content: hostContent,
  readOnly: false,
  active: true,
  loadFontFamilies: async () => [],
  onChange(content) {
    changeCount += 1;
    lastChangedContent = content;
    hostContent = content;
    props.content = content;
    render();
  },
  onReady(nextHandle) {
    if (nextHandle) readyCount += 1;
    handle = nextHandle;
  },
  onError(error) { lastError = error.message; },
  async onSaveAs(request) {
    saveAsRequest = request;
    throw new Error("fixture save-as failure");
  },
};

function render() {
  if (unmounted) return;
  root.render(<main className="fixture-main">
    <RichTextEditor {...props} />
  </main>);
}

function findEditorView(): EditorView | undefined {
  const content = document.querySelector(".cm-content");
  if (!content) return undefined;
  try { return EditorView.findFromDOM(content) ?? undefined; }
  catch { return undefined; }
}

function snapshot(includeText = false) {
  const view = findEditorView();
  const model = view?.state.doc.toString();
  if (view && !editorView) editorView = view;
  return {
    changeCount,
    readyCount,
    handleAvailable: handle !== null,
    contentLength: hostContent.length,
    normalizedHostLength: hostContent.replace(/\r\n?/g, "\n").length,
    changedLength: lastChangedContent?.length ?? null,
    hostMatchesLastChange: lastChangedContent === undefined || lastChangedContent === hostContent,
    modelMatchesHost: model === undefined ? false : model === hostContent.replace(/\r\n?/g, "\n"),
    hostHasBom: hostContent.startsWith("\uFEFF"),
    hostHasTerminalBlankLines: hostContent.endsWith("\r\n\r\n") || hostContent.endsWith("\n\n"),
    hostPrefix: hostContent.slice(0, 40),
    modelLength: model?.length ?? null,
    modelLines: view?.state.doc.lines ?? null,
    selectionLine: view ? view.state.doc.lineAt(view.state.selection.main.from).number : null,
    ...(includeText ? {hostContent, model} : {}),
    visibleLineCount: document.querySelectorAll(".cm-line").length,
    searchInputValue: document.querySelector<HTMLInputElement>(".cm-search input")?.value ?? null,
    isVirtual: document.querySelector(".rich-text-editor")?.hasAttribute("data-virtual-text") ?? false,
    editable: view?.contentDOM.contentEditable ?? null,
    sameEditorView: view ? view === editorView : false,
    error: lastError ?? null,
    saveAsRequest: saveAsRequest ? {
      extension: saveAsRequest.extension,
      contentLength: saveAsRequest.content.length,
      contentPrefix: saveAsRequest.content.slice(0, 40),
    } : null,
    errorText: document.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

const fixture: FixtureApi = {
  snapshot,
  focusAt(index) {
    const view = findEditorView();
    if (!view) throw new Error("CodeMirror has not mounted.");
    const position = Math.max(0, Math.min(index, view.state.doc.length));
    view.dispatch({selection: {anchor: position}});
    view.focus();
  },
  pasteAt(index, value) {
    const view = findEditorView();
    if (!view) throw new Error("CodeMirror has not mounted.");
    const position = Math.max(0, Math.min(index, view.state.doc.length));
    view.dispatch({selection: {anchor: position}});
    view.focus();
    const data = new DataTransfer();
    data.setData("text/plain", value);
    return view.contentDOM.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: data,
    }));
  },
  setProps(patch) {
    props = {...props, ...patch};
    if (Object.hasOwn(patch, "content")) hostContent = patch.content ?? "";
    render();
  },
  contextActions() { return handle?.getContextMenuActions?.() ?? []; },
  async runConvert() {
    const action = fixture.contextActions().find(item => item.id === "convert-to-rich-text");
    if (!action) throw new Error("The plain-text conversion action is not registered.");
    await action.run();
  },
  unmount() {
    if (unmounted) return;
    unmounted = true;
    root.unmount();
  },
};

document.documentElement.style.cssText = "height:100%;";
document.body.style.cssText = "height:100%;margin:0;font:14px/1.5 system-ui,sans-serif;";
const style = document.createElement("style");
style.textContent = `
  #app, .fixture-main, .rich-text-editor { height: 100%; min-height: 0; }
  .rich-text-editor { color: #222; font: 14px/1.5 system-ui, sans-serif; }
  .rich-text-editor-root { height: 100%; min-height: 0; }
  .rich-text-editor-mount, .rich-text-editor-quill-root { height: 100%; }
  .large-plain-text-editor .cm-editor { height: 100%; min-height: 20rem; font: inherit; }
  .large-plain-text-editor .cm-scroller { overflow: auto; font: inherit; line-height: 1.5; }
`;
document.head.append(style);
window.__largePlainTextFixture = fixture;
render();

declare global {
  interface Window { __largePlainTextFixture: FixtureApi }
}
