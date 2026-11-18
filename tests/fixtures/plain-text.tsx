import {createRoot, type Root} from "react-dom/client";
import PlainTextEditor from "../../src/plugins/plain-text-editor/PlainTextEditor";
import {createPlainTextDriver, getPlainTextDriver} from "../../src/plugins/plain-text-editor/plainTextDriver";
import {createAssetCompletionSource} from "../../src/plugins/asset-completion/assetCompletionSource";
import {createEditorCompletionRegistry} from "../../src/plugins/body-editor/editorCompletionRegistry";
import type {EditorHandle, EditorProps} from "../../packages/sdk/src/body-editor";
import type {AssetCatalogSnapshot} from "../../packages/sdk/src/asset-catalog";
import "../../src/styles/theme-colors.css";
import "../../src/styles/tokens.css";

const lineCount = 198_037;
function lineText(index: number): string {
  const content = index === 187_654 ? "UNIQUE_TARGET_TOKEN"
    : index === 50 ? "hit hitword Hit"
      : index === 51 ? "tag-10 tag-20 tag-30x"
        : "x".repeat(index % 2 ? 20 : 21);
  return `line-${String(index).padStart(6, "0")}-${content}`;
}
const initialContent = `\uFEFF${Array.from({length: lineCount}, (_, index) => lineText(index)).join("\r\n")}\r\n\r\n`;

type FixtureApi = {
  snapshot(): Record<string, unknown>;
  focusAt(index: number): void;
  setSelection(anchor: number, head: number): void;
  pasteAt(index: number, value: string): boolean;
  clipboardAt(kind: "copy" | "cut", from: number, to: number): Record<string, unknown>;
  clipboardCurrent(kind: "copy" | "cut"): Record<string, unknown>;
  pointAt(offset: number): {x: number; y: number};
  viewportState(): {scrollTop: number; scrollHeight: number; bottom: number};
  setSearch(query: string, replacement: string, options: {caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean}): void;
  clickSearch(label: string): void;
  lineBreakCounts(): {crlf: number; lf: number; cr: number};
  countText(text: string): number;
  find(query: string): boolean;
  replaceSelection(text: string): void;
  hasText(text: string): boolean;
  exactSlice(from: number, to: number, expected: string): boolean;
  setProps(patch: Partial<Pick<EditorProps, "content" | "readOnly" | "active">>): void;
  setPropsWithoutRender(patch: Partial<Pick<EditorProps, "content" | "readOnly" | "active">>): void;
  renderProps(): void;
  flushContent(currentContent?: string): string;
  setCompletionAssets(names: readonly string[]): void;
  completionSettled(): Promise<void>;
  openCompletion(): void;
  removeCompletion(): void;
  stageNativeInput(text: string): void;
  resetFrameStats(): void;
  frameStats(): {maxGapMs: number; samples: number};
  startEditTiming(): void;
  editTiming(): {elapsedMs: number; firstEditMs?: number; lastEditMs?: number; changes: number};
  testDriverInitFailure(kind: "canvas" | "resize-observer"): {threw: boolean; message?: string; rootChildren: number; driverRegistered: boolean; documentListenersAdded: number; documentListenersRemoved: number; temporaryRootsRemaining: number};
  checkpoint(name: string): void;
  matchesCheckpoint(name: string): boolean;
  unmount(): void;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("The browser fixture root is missing.");
const root: Root = createRoot(app);
let props: EditorProps = {
  documentId: "plain-text-browser-regression",
  format: "plain-text",
  content: initialContent,
  readOnly: false,
  active: true,
  onChange: () => {},
  onReady: () => {},
  onError: () => {},
};
let hostContent = initialContent;
let changeCount = 0;
let lastChangedContent: string | undefined;
let handle: EditorHandle | null = null;
let unmounted = false;
let initialDriver: ReturnType<typeof getPlainTextDriver>;
let errorText: string | undefined;
const completionRegistry = createEditorCompletionRegistry();
let catalogSnapshot: AssetCatalogSnapshot;
const catalogListeners = new Set<() => void>();
let removeCompletion: (() => void) | undefined;
let lastCompletionQuery: Promise<unknown> | undefined;
const contentCheckpoints = new Map<string, string>();
const fixtureStart = performance.now();
let readyMs: number | undefined;
let editTimer: {started: number; changes: number; first?: number; last?: number} | undefined;
let lastFrameTime: number | undefined;
const frameGaps: number[] = [];
const requestAnimationFrameOriginal = window.requestAnimationFrame.bind(window);
let frameMonitorActive = false;
function monitorFrames(time: number) {
  if (!frameMonitorActive) return;
  if (lastFrameTime !== time) {
    if (lastFrameTime !== undefined) frameGaps.push(time - lastFrameTime);
    lastFrameTime = time;
  }
  requestAnimationFrameOriginal(monitorFrames);
}

props = {
  ...props,
  onChange(content) {
    changeCount += 1;
    lastChangedContent = content;
    hostContent = content;
    if (editTimer) {
      const elapsed = performance.now() - editTimer.started;
      editTimer.changes += 1;
      editTimer.first ??= elapsed;
      editTimer.last = elapsed;
    }
    props = {...props, content};
    render();
  },
  onReady(nextHandle) {
    handle = nextHandle;
    if (nextHandle && readyMs === undefined) readyMs = performance.now() - fixtureStart;
  },
  onError(error) { errorText = error.message; },
};

function render() {
  if (!unmounted) root.render(<main className="fixture-main"><PlainTextEditor {...props}/></main>);
}

function getDriver() {
  const editor = document.querySelector<HTMLElement>(".plain-text-editor");
  return editor ? getPlainTextDriver(editor) : undefined;
}

function snapshot() {
  const driver = getDriver();
  const state = driver?.getDebugState();
  if (driver && !initialDriver) initialDriver = driver;
  const model = driver?.getContent();
  return {
    handleAvailable: handle !== null,
    readyMs,
    changeCount,
    hostLength: hostContent.length,
    modelLength: model?.length ?? null,
    modelMatchesHost: model === hostContent,
    hostMatchesLastChange: lastChangedContent === undefined || lastChangedContent === hostContent,
    hasBom: hostContent.startsWith("\uFEFF"),
    hasCRLF: hostContent.includes("\r\n"),
    hasLoneLF: /(?<!\r)\n/.test(hostContent),
    hasTerminalBlankLines: hostContent.endsWith("\r\n\r\n"),
    lineCount: state?.lineCount ?? null,
    renderedLines: document.querySelectorAll(".plain-text-line[data-line][data-from]").length,
    debugRenderedLines: state?.renderedLines ?? null,
    readOnly: state?.readOnly ?? null,
    selection: state?.selection ?? null,
    selectionLine: state ? driver?.getContent().slice(0, state.selection.head).split(/\r\n|\n|\r/).length - 1 : null,
    sameDriver: driver === initialDriver,
    errorText: errorText ?? document.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

const fixture: FixtureApi = {
  snapshot,
  focusAt(index) {
    const driver = getDriver();
    if (!driver) throw new Error("The plain text driver has not mounted.");
    driver.setSelection(index, index, true);
    driver.focus();
  },
  setSelection(anchor, head) {
    const driver = getDriver();
    if (!driver) throw new Error("The plain text driver has not mounted.");
    driver.setSelection(anchor, head, true);
  },
  pasteAt(index, value) {
    const driver = getDriver();
    const input = document.querySelector<HTMLTextAreaElement>("textarea.plain-text-input");
    if (!driver || !input) throw new Error("The plain text input has not mounted.");
    driver.setSelection(index, index, true);
    driver.focus();
    const data = new DataTransfer();
    data.setData("text/plain", value);
    return input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: data,
    }));
  },
  clipboardAt(kind, from, to) {
    const driver = getDriver();
    const input = document.querySelector<HTMLTextAreaElement>("textarea.plain-text-input");
    if (!driver || !input) throw new Error("The plain text input has not mounted.");
    driver.setSelection(from, to, true);
    driver.focus();
    const data = new DataTransfer();
    const event = new ClipboardEvent(kind, {bubbles: true, cancelable: true, clipboardData: data});
    const expectedText = driver.getContent().slice(Math.min(from, to), Math.max(from, to));
    const dispatched = input.dispatchEvent(event);
    const copiedText = data.getData("text/plain");
    const current = driver.getContent();
    return {
      dispatched,
      defaultPrevented: event.defaultPrevented,
      copiedLength: copiedText.length,
      clipboardMatchesSelection: copiedText === expectedText,
      modelLength: current.length,
    };
  },
  clipboardCurrent(kind) {
    const input = document.querySelector<HTMLTextAreaElement>("textarea.plain-text-input");
    const driver = getDriver();
    if (!input || !driver) throw new Error("The plain text input has not mounted.");
    const {anchor, head} = driver.getSelection();
    const from = Math.min(anchor, head), to = Math.max(anchor, head);
    const expected = driver.getContent().slice(from, to);
    const data = new DataTransfer();
    const event = new ClipboardEvent(kind, {bubbles: true, cancelable: true, clipboardData: data});
    input.dispatchEvent(event);
    const copied = data.getData("text/plain");
    return {defaultPrevented: event.defaultPrevented, copiedLength: copied.length,
      clipboardMatchesSelection: copied === expected, selection: driver.getSelection()};
  },
  pointAt(offset) {
    const driver = getDriver();
    if (!driver) throw new Error("The plain text driver has not mounted.");
    driver.setSelection(offset, offset, true);
    const element = [...document.querySelectorAll<HTMLElement>(".plain-text-line[data-from][data-to]")]
      .find(row => Number(row.dataset.from) <= offset && Number(row.dataset.to) >= offset);
    if (!element) throw new Error(`No rendered visual row contains offset ${offset}.`);
    const from = Number(element.dataset.from);
    const local = Math.max(0, Math.min(offset - from, element.textContent?.length ?? 0));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = local;
    let node = walker.nextNode();
    let target: Text | null = null;
    let nodeOffset = 0;
    let previous: Text | null = null;
    while (node) {
      const textNode = node as Text;
      if (remaining <= textNode.length) { target = textNode; nodeOffset = remaining; break; }
      remaining -= textNode.length;
      previous = textNode;
      node = walker.nextNode();
    }
    if (!target) { target = previous; nodeOffset = target?.length ?? 0; }
    if (!target) throw new Error("The rendered row has no text node.");
    const range = document.createRange();
    range.setStart(target, nodeOffset);
    if (nodeOffset < target.length) range.setEnd(target, nodeOffset + 1);
    else range.collapse(true);
    const rect = range.getBoundingClientRect();
    const rowRect = element.getBoundingClientRect();
    return {x: rect.width ? rect.left + rect.width / 2 : rect.left,
      y: rowRect.top + rowRect.height / 2};
  },
  viewportState() {
    const viewport = document.querySelector<HTMLElement>(".plain-text-viewport");
    if (!viewport) throw new Error("The plain text viewport has not mounted.");
    return {scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
      bottom: viewport.getBoundingClientRect().bottom};
  },
  find(query) {
    const driver = getDriver();
    if (!driver) throw new Error("The plain text driver has not mounted.");
    return driver.find(query);
  },
  replaceSelection(text) {
    const driver = getDriver();
    if (!driver) throw new Error("The plain text driver has not mounted.");
    driver.replaceSelection(text);
  },
  hasText(text) {
    const driver = getDriver();
    return !!driver && driver.getContent().includes(text);
  },
  countText(text) {
    const source = getDriver()?.getContent() ?? "";
    if (!text) return 0;
    let count = 0, from = 0;
    while ((from = source.indexOf(text, from)) >= 0) { count++; from += text.length; }
    return count;
  },
  lineBreakCounts() {
    const source = getDriver()?.getContent() ?? "";
    let crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\r" && source[i + 1] === "\n") { crlf++; i++; }
      else if (source[i] === "\n") lf++;
      else if (source[i] === "\r") cr++;
    }
    return {crlf, lf, cr};
  },
  setSearch(query, replacement, options) {
    const panel = document.querySelector<HTMLElement>(".plain-text-search");
    if (!panel || panel.hidden) throw new Error("Open the find panel before setting its controls.");
    const queryInput = panel.querySelector<HTMLInputElement>('input[aria-label="查找文本"]');
    const replacementInput = panel.querySelector<HTMLInputElement>('input[aria-label="替换文本"]');
    if (!queryInput || !replacementInput) throw new Error("The search inputs have not mounted.");
    queryInput.value = query;
    queryInput.dispatchEvent(new Event("input", {bubbles: true}));
    replacementInput.value = replacement;
    replacementInput.dispatchEvent(new Event("input", {bubbles: true}));
    for (const name of ["caseSensitive", "regexp", "wholeWord"] as const) {
      const label = [...panel.querySelectorAll("label")].find(item => item.textContent?.includes(
        name === "caseSensitive" ? "区分大小写" : name === "regexp" ? "正则表达式" : "全词匹配"));
      const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox) throw new Error(`Search option ${name} is not present.`);
      checkbox.checked = options[name] ?? false;
    }
  },
  clickSearch(label) {
    const panel = document.querySelector<HTMLElement>(".plain-text-search");
    const button = [...(panel?.querySelectorAll("button") ?? [])].find(item => item.textContent === label);
    if (!button) throw new Error(`Search button '${label}' is not present.`);
    button.click();
  },
  exactSlice(from, to, expected) {
    const driver = getDriver();
    return !!driver && driver.getContent().slice(from, to) === expected;
  },
  setProps(patch) {
    if (Object.hasOwn(patch, "content")) hostContent = patch.content ?? "";
    props = {...props, ...patch};
    render();
  },
  setPropsWithoutRender(patch) {
    if (Object.hasOwn(patch, "content")) hostContent = patch.content ?? "";
    props = {...props, ...patch};
  },
  renderProps() { render(); },
  flushContent(currentContent) {
    if (!handle?.flushContent) throw new Error("The plain text editor has no flush-capable handle.");
    return handle.flushContent(currentContent);
  },
  setCompletionAssets(names) {
    catalogSnapshot = {
      types: [{id: "people", name: "角色", status: "active"}, {id: "places", name: "地点", status: "active"}],
      assets: names.map((name, index) => ({id: String(index), name, description: "", typeId: name.endsWith("湾") ? "places" : "people"})),
      loaded: true, loading: false, error: null, blocked: false,
    };
    if (!removeCompletion) {
      const source = createAssetCompletionSource({
        getSnapshot: () => catalogSnapshot,
        subscribe(listener) { catalogListeners.add(listener); return () => catalogListeners.delete(listener); },
        retry: async () => true,
      });
      const remove = completionRegistry.register("fixture", "plain-text", source);
      removeCompletion = () => { remove(); source.dispose(); };
      const completion = completionRegistry.connect("fixture", "plain-text");
      props = {...props, completion: {...completion, query(textBefore, signal) {
        const result = completion.query(textBefore, signal);
        lastCompletionQuery = result;
        return result;
      }}};
      render();
    } else catalogListeners.forEach(listener => listener());
  },
  async completionSettled() { await lastCompletionQuery; },
  removeCompletion() {
    removeCompletion?.();
    removeCompletion = undefined;
  },
  openCompletion() {
    const action = handle?.getContextMenuActions?.().find(item => item.id === "show-completion");
    if (!action) throw new Error("The editor did not contribute its completion action.");
    void action.run();
  },
  stageNativeInput(text) {
    const input = document.querySelector<HTMLTextAreaElement>("textarea.plain-text-input");
    if (!input) throw new Error("The plain text input has not mounted.");
    const from = input.selectionStart;
    const to = input.selectionEnd;
    input.value = input.value.slice(0, from) + text + input.value.slice(to);
    const caret = from + text.length;
    input.setSelectionRange(caret, caret);
  },
  resetFrameStats() {
    frameGaps.length = 0;
    lastFrameTime = undefined;
    if (!frameMonitorActive) {
      frameMonitorActive = true;
      requestAnimationFrameOriginal(monitorFrames);
    }
  },
  frameStats() {
    frameMonitorActive = false;
    return {maxGapMs: Math.max(0, ...frameGaps), samples: frameGaps.length};
  },
  startEditTiming() { editTimer = {started: performance.now(), changes: 0}; },
  editTiming() {
    if (!editTimer) throw new Error("Edit timing has not started.");
    const value = {elapsedMs: performance.now() - editTimer.started, firstEditMs: editTimer.first,
      lastEditMs: editTimer.last, changes: editTimer.changes};
    editTimer = undefined;
    return value;
  },
  testDriverInitFailure(kind) {
    const root = document.createElement("div");
    root.className = "plain-text-init-failure-test-root";
    document.body.append(root);
    let threw = false;
    let message: string | undefined;
    const documentListenersAdded = {pointerdown: 0, keydown: 0};
    const documentListenersRemoved = {pointerdown: 0, keydown: 0};
    const addDescriptor = Object.getOwnPropertyDescriptor(document, "addEventListener");
    const removeDescriptor = Object.getOwnPropertyDescriptor(document, "removeEventListener");
    const canvasDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    const resizeDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    try {
      Object.defineProperty(document, "addEventListener", {configurable: true, value(type: string,
        listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (type === "pointerdown" || type === "keydown") documentListenersAdded[type]++;
        return EventTarget.prototype.addEventListener.call(document, type, listener, options);
      }});
      Object.defineProperty(document, "removeEventListener", {configurable: true, value(type: string,
        listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if (type === "pointerdown" || type === "keydown") documentListenersRemoved[type]++;
        return EventTarget.prototype.removeEventListener.call(document, type, listener, options);
      }});
      if (kind === "canvas") {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {configurable: true, value: () => null});
      } else {
        Object.defineProperty(window, "ResizeObserver", {configurable: true, writable: true,
          value: class { constructor() { throw new Error("fixture ResizeObserver construction failure"); } }});
      }
      try {
        createPlainTextDriver(root, "fixture", {onChange() {}, onError() {}});
      } catch (error) {
        threw = true;
        message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (addDescriptor) Object.defineProperty(document, "addEventListener", addDescriptor);
      else Reflect.deleteProperty(document, "addEventListener");
      if (removeDescriptor) Object.defineProperty(document, "removeEventListener", removeDescriptor);
      else Reflect.deleteProperty(document, "removeEventListener");
      if (canvasDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasDescriptor);
      if (resizeDescriptor) Object.defineProperty(window, "ResizeObserver", resizeDescriptor);
      else Reflect.deleteProperty(window, "ResizeObserver");
    }
    const result = {threw, message, rootChildren: root.childElementCount,
      driverRegistered: getPlainTextDriver(root) !== undefined,
      documentListenersAdded: Object.values(documentListenersAdded).reduce((sum, value) => sum + value, 0),
      documentListenersRemoved: Object.values(documentListenersRemoved).reduce((sum, value) => sum + value, 0)};
    root.remove();
    return {...result, temporaryRootsRemaining: document.querySelectorAll(".plain-text-init-failure-test-root").length};
  },
  checkpoint(name) {
    const content = getDriver()?.getContent();
    if (content === undefined) throw new Error("The plain text driver has not mounted.");
    contentCheckpoints.set(name, content);
  },
  matchesCheckpoint(name) {
    const content = contentCheckpoints.get(name);
    return content !== undefined && getDriver()?.getContent() === content;
  },
  unmount() {
    if (unmounted) return;
    unmounted = true;
    root.unmount();
    fixture.removeCompletion();
    completionRegistry.dispose();
  },
};

document.documentElement.style.cssText = "height:100%;";
document.body.style.cssText = "height:100%;margin:0;font:14px/1.5 system-ui,sans-serif;";
const style = document.createElement("style");
style.textContent = `
  #app, .plain-text-editor { height: 100%; min-height: 0; }
  .fixture-main { height: 640px; min-height: 0; }
  .plain-text-editor { color: #222; font: 14px/1.5 system-ui, sans-serif; }
  .plain-text-viewport { height: 100%; overflow: auto; }
`;
document.head.append(style);
window.__plainTextFixture = fixture;
render();

declare global {
  interface Window { __plainTextFixture: FixtureApi }
}
