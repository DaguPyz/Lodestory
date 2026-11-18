import type {EditorCompletion, EditorHighlights} from "@lodestory/sdk/body-editor";
import {createPlainTextModel, normalizeInsertedText} from "./textModel";
import {createPlainTextHistory} from "./history";
import {nextTextBoundary, previousTextBoundary, TextLayout} from "./textLayout";
import {createPlainTextCompletion} from "./plainTextCompletion";
import {appendStyledText, createPlainTextHighlights} from "./plainTextHighlights";

export type TextSelection = {anchor: number; head: number};
type SearchOptions = {caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean};
export type PlainTextDriver = ReturnType<typeof createPlainTextDriver>;
const drivers = new WeakMap<HTMLElement, PlainTextDriver>();
const completionContextLimit = 128;
export function getPlainTextDriver(root: HTMLElement) { return drivers.get(root); }

/** Native input/IME is a small moving buffer; the complete document lives in our text model. */
export function createPlainTextDriver(root: HTMLElement, initialContent: string, callbacks: {
  onChange(content: string): void;
  onError(error: Error): void;
}) {
  let model = createPlainTextModel(initialContent);
  let history = createPlainTextHistory(model);
  const initialCaret = initialContent.startsWith("\uFEFF") ? 1 : 0;
  let selection: TextSelection = {anchor: initialCaret, head: initialCaret};
  let readOnly = true;
  let destroyed = false;
  let composing = false;
  let compositionId = 0;
  let bufferFrom = 0;
  let bufferValue = "";
  let bufferReplacesSelection = false;
  let frame = 0;
  let compositionTimer = 0;
  let dragFrame = 0;
  let drag: {x: number; y: number} | undefined;
  let preferredX: number | undefined;
  let lastEditAt = 0;
  let completionSource: EditorCompletion | undefined;
  let completion: ReturnType<typeof createPlainTextCompletion> | undefined;
  let completionFrame = 0;
  let highlightSource: EditorHighlights | undefined;
  let highlights: ReturnType<typeof createPlainTextHighlights> | undefined;
  const disposers: (() => void)[] = [];
  const viewport = document.createElement("div");
  viewport.className = "plain-text-viewport";
  const content = document.createElement("div");
  content.className = "plain-text-content";
  const layer = document.createElement("div");
  layer.className = "plain-text-lines";
  layer.setAttribute("aria-hidden", "true");
  const caret = document.createElement("div");
  caret.className = "plain-text-caret";
  const input = document.createElement("textarea");
  input.className = "plain-text-input";
  input.setAttribute("aria-label", "纯文本正文");
  input.setAttribute("aria-multiline", "true");
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.wrap = "off";
  const search = createSearchPanel();
  content.append(layer, caret, input);
  viewport.append(content);
  root.append(search.panel, viewport);
  let layout: TextLayout;
  try { layout = new TextLayout(model, document.createElement("canvas")); }
  catch (error) { disposers.forEach(dispose => dispose()); root.replaceChildren(); throw error; }
  let lineHeight = 32;
  let padding = 48;
  let textLeft = 48;
  let textWidth = 720;
  let measuredFont = "";

  function on<K extends keyof HTMLElementEventMap>(target: HTMLElement | Document, name: K,
    listener: (event: HTMLElementEventMap[K]) => void, capture = false) {
    const handler = listener as EventListener;
    target.addEventListener(name, handler, capture);
    disposers.push(() => target.removeEventListener(name, handler, capture));
  }
  function guard<T>(action: () => T) {
    if (destroyed) return;
    try { return action(); }
    catch (reason) { callbacks.onError(reason instanceof Error ? reason : new Error(String(reason))); }
  }
  function configure() {
    if (destroyed || viewport.clientWidth === 0) return;
    const style = getComputedStyle(content);
    lineHeight = Number.parseFloat(style.lineHeight) || 32;
    padding = Number.parseFloat(style.paddingLeft) || 24;
    textWidth = Math.max(1, Math.min(720, viewport.clientWidth - padding * 2));
    textLeft = Math.max(padding, (viewport.clientWidth - textWidth) / 2);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const first = layout.rowCount ? layout.rowAt(Math.max(0, (viewport.scrollTop - padding) / lineHeight)) : undefined;
    const anchor = first ? model.offsetAt(first.line, first.start) : 0;
    const previousRow = first?.index ?? 0;
    if (layout.configure(textWidth, font) && first) {
      viewport.scrollTop += (layout.rowForOffset(anchor).index - previousRow) * lineHeight;
    }
    measuredFont = font;
    render();
  }
  function scheduleRender() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; guard(render); });
  }
  function render() {
    if (destroyed || !layout.rowCount) return;
    layer.style.left = `${textLeft}px`;
    layer.style.width = `${textWidth}px`;
    const first = Math.max(0, Math.min(layout.rowCount - 1, Math.floor((viewport.scrollTop - padding) / lineHeight) - 6));
    const last = Math.ceil((viewport.scrollTop + viewport.clientHeight - padding) / lineHeight) + 6;
    const fragment = document.createDocumentFragment();
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    const highlightRanges = highlights?.ranges();
    let visibleFrom: number | undefined;
    let visibleTo = 0;
    for (let i = first; i < Math.min(layout.rowCount, last); i++) {
      const row = layout.rowAt(i);
      // Resolving an overestimated line can remove rows during this loop.
      if (row.index !== i) { scheduleRender(); break; }
      const line = model.getLine(row.line);
      const rowFrom = line.from + row.start;
      const rowTo = line.from + row.end;
      visibleFrom ??= rowFrom;
      visibleTo = rowTo;
      const text = model.slice(rowFrom, rowTo);
      const element = document.createElement("div");
      element.className = "plain-text-line";
      element.dataset.line = String(row.line);
      element.dataset.from = String(rowFrom);
      element.dataset.to = String(rowTo);
      element.style.top = `${padding + i * lineHeight}px`;
      element.style.height = `${lineHeight}px`;
      const selectedFrom = Math.max(from, rowFrom), selectedTo = Math.min(to, rowTo);
      if (selectedFrom < selectedTo || highlightRanges?.length) {
        appendStyledText(element, text, rowFrom, selectedFrom, selectedTo, highlightRanges);
      } else element.textContent = text;
      if (from <= rowTo && to > rowTo && row.end === line.text.length && line.toWithBreak > line.to) {
        const mark = document.createElement("span");
        mark.className = "plain-text-selected plain-text-selected-break";
        mark.textContent = " ";
        element.append(mark);
      }
      if (!element.childNodes.length) element.append(document.createTextNode("\u200b"));
      fragment.append(element);
    }
    layer.replaceChildren(fragment);
    if (!composing && visibleFrom !== undefined) highlights?.request(visibleFrom, visibleTo, model.length, model.slice);
    const row = layout.rowForOffset(selection.head);
    const line = model.getLine(row.line);
    const x = textLeft + layout.xAt(line.text.slice(row.start, row.end), Math.max(0, Math.min(row.end, selection.head - line.from) - row.start));
    const y = padding + row.index * lineHeight;
    caret.style.cssText = `left:${x}px;top:${y}px;height:${lineHeight}px;`;
    caret.hidden = selection.anchor !== selection.head || readOnly || document.activeElement !== input;
    input.style.left = `${Math.min(x, viewport.clientWidth - 4)}px`;
    input.style.top = `${y}px`;
    input.style.height = `${lineHeight}px`;
    content.style.height = `${Math.max(viewport.clientHeight, layout.rowCount * lineHeight + padding * 2)}px`;
    completion?.position();
  }
  function getCompletionContext() {
    const {anchor, head} = selection;
    if (readOnly || destroyed || composing || compositionTimer || anchor !== head || document.activeElement !== input) return;
    const before = model.slice(Math.max(0, head - completionContextLimit), head);
    const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
    return {head, textBefore: before.slice(lineStart).replace(/^[\uFEFF\uDC00-\uDFFF]/u, "")};
  }
  function setCompletion(source?: EditorCompletion) {
    if (destroyed || source === completionSource) return;
    completion?.destroy();
    completion = undefined;
    completionSource = source;
    if (!source) return;
    completion = createPlainTextCompletion(root, viewport, caret, input, source, getCompletionContext, (candidate, head) =>
      guard(() => {
        if (getCompletionContext()?.head !== head) return false;
        const from = head - candidate.match.length;
        if (from < 0 || model.slice(from, head) !== candidate.match) return false;
        history.breakGroup();
        edit(from, head, candidate.insertText);
        return true;
      }) ?? false);
  }
  function openCompletion() {
    if (readOnly || destroyed || composing || completionFrame) return;
    // The context menu must release its focus scope before focusing the editor.
    completionFrame = requestAnimationFrame(() => guard(() => {
      completionFrame = 0;
      if (readOnly || composing || !completion?.isAvailable()) return;
      input.focus({preventScroll: true});
      render();
      completion.request(false);
    }));
  }
  function syncInput() {
    if (composing || destroyed) return;
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    const line = model.lineAt(from);
    bufferReplacesSelection = to > line.to || to - from > 2048;
    if (bufferReplacesSelection) {
      bufferFrom = from;
      // A native selection keeps standard Copy/Cut enabled even when the real
      // selection spans text which is deliberately absent from the input buffer.
      bufferValue = "\u200b";
      input.value = bufferValue;
      input.setSelectionRange(0, 1);
      return;
    }
    bufferFrom = Math.max(line.from, from - 1024);
    if (bufferFrom > line.from && /[\uDC00-\uDFFF]/.test(model.slice(bufferFrom, bufferFrom + 1))) bufferFrom--;
    const end = Math.min(line.to, Math.max(to, from + 1024));
    bufferValue = model.slice(bufferFrom, end);
    input.value = bufferValue;
    input.setSelectionRange(from - bufferFrom, to - bufferFrom, selection.anchor > selection.head ? "backward" : "forward");
  }
  function setSelection(anchor: number, head = anchor, scrollIntoView = true) {
    completion?.close();
    history.breakGroup();
    selection = {anchor: Math.max(0, Math.min(anchor, model.length)), head: Math.max(0, Math.min(head, model.length))};
    preferredX = undefined;
    if (scrollIntoView) reveal();
    syncInput();
    render();
  }
  function reveal() {
    const y = padding + layout.rowForOffset(selection.head).index * lineHeight;
    if (y < viewport.scrollTop) viewport.scrollTop = Math.max(0, y - lineHeight);
    else if (y + lineHeight > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = y + lineHeight * 2 - viewport.clientHeight;
    }
  }
  function notify() { callbacks.onChange(model.getText()); }
  function edit(from: number, to: number, insert: string, group?: string, after?: TextSelection, preserveInput = false, rawInsert = false) {
    if (readOnly || destroyed) return;
    completion?.close();
    const first = model.lineAt(from).number, last = model.lineAt(to).number;
    const beforeLines = model.lineCount;
    const normalized = rawInsert ? insert : normalizeInsertedText(insert, model.lineSeparator);
    const next = after ?? {anchor: from + normalized.length, head: from + normalized.length};
    if (model.slice(from, to) === normalized) {
      selection = next;
      if (!preserveInput) syncInput();
      render();
      return;
    }
    const now = performance.now();
    if (!composing && now - lastEditAt > 1000) history.breakGroup();
    lastEditAt = now;
    history.apply(from, to, normalized, {before: {...selection}, after: next, group});
    highlights?.edit(from, to, normalized.length);
    selection = next;
    layout.update(first, last - first + 1, model.lineCount - beforeLines + last - first + 1);
    preferredX = undefined;
    reveal();
    if (!preserveInput) syncInput();
    render();
    notify();
  }
  function replaceSelection(text: string, group?: string) {
    edit(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), text, group);
  }
  function applyInput() {
    if (readOnly) { syncInput(); return false; }
    const value = input.value;
    if (value === bufferValue) return false;
    let prefix = 0;
    while (prefix < value.length && prefix < bufferValue.length && value[prefix] === bufferValue[prefix]) prefix++;
    let suffix = 0;
    while (suffix < value.length - prefix && suffix < bufferValue.length - prefix
      && value[value.length - 1 - suffix] === bufferValue[bufferValue.length - 1 - suffix]) suffix++;
    const from = bufferReplacesSelection ? Math.min(selection.anchor, selection.head)
      : bufferFrom + normalizeInsertedText(bufferValue.slice(0, prefix), model.lineSeparator).length;
    const to = bufferReplacesSelection ? Math.max(selection.anchor, selection.head)
      : bufferFrom + normalizeInsertedText(bufferValue.slice(0, bufferValue.length - suffix), model.lineSeparator).length;
    const insert = value.slice(prefix, value.length - suffix);
    const caretPrefix = normalizeInsertedText(value.slice(0, input.selectionEnd), model.lineSeparator).length;
    const nextHead = (bufferReplacesSelection ? from : bufferFrom) + caretPrefix;
    edit(from, to, insert, composing ? `composition:${compositionId}` : "typing",
      {anchor: nextHead, head: nextHead}, true);
    if (bufferReplacesSelection) bufferFrom = from;
    bufferReplacesSelection = false;
    bufferValue = value;
    if (!composing) syncInput();
    return true;
  }
  function finishComposition(keepFocus = true) {
    if (!composing) return;
    const hadFocus = document.activeElement === input;
    applyInput();
    input.blur();
    // WebKit and Chromium may commit the final native value during blur.
    applyInput();
    composing = false;
    history.breakGroup();
    syncInput();
    if (keepFocus && hadFocus) input.focus({preventScroll: true});
  }
  function restore(action: "undo" | "redo") {
    if (readOnly || composing || destroyed) return;
    completion?.close();
    const change = action === "undo" ? history.peekUndo() : history.peekRedo();
    if (!change) return;
    const first = model.lineAt(change.from).number, last = model.lineAt(change.to).number;
    const beforeLines = model.lineCount;
    const result = history[action]();
    if (!result) return;
    highlights?.edit(change.from, change.to, change.insert.length);
    selection = result;
    layout.update(first, last - first + 1, model.lineCount - beforeLines + last - first + 1);
    syncInput(); reveal(); render(); notify();
  }
  function boundary(offset: number, forward: boolean) {
    const line = model.lineAt(offset);
    if (forward) {
      if (offset >= line.to) return line.toWithBreak;
      const row = layout.rowForOffset(offset);
      const context = model.slice(offset, line.from + row.end);
      return offset + nextTextBoundary(context, 0);
    }
    if (offset <= line.from) return line.number > 0 ? model.getLine(line.number - 1).to : 0;
    if (offset > line.to) return line.to;
    const row = layout.rowForOffset(offset);
    let start = line.from + row.start;
    if (start === offset && row.index > 0) {
      const previous = layout.rowAt(row.index - 1);
      start = model.getLine(previous.line).from + previous.start;
    }
    return start + previousTextBoundary(model.slice(start, offset), offset - start);
  }
  function deleteSelection(forward: boolean, byWord = false, toLineEnd = false) {
    const {anchor, head} = selection;
    if (anchor !== head) {
      replaceSelection("");
    } else {
      const other = toLineEnd ? model.lineAt(head)[forward ? "to" : "from"]
        : byWord ? wordBoundary(head, forward) : boundary(head, forward);
      if (other === head) return;
      edit(Math.min(other, head), Math.max(other, head), "", "delete");
    }
    completion?.request(true);
  }
  function wordBoundary(offset: number, forward: boolean) {
    const start = Math.max(0, offset - 4096), end = Math.min(model.length, offset + 4096);
    const text = model.slice(start, end), local = offset - start;
    const word = /[\p{L}\p{N}_]/u;
    if (forward) {
      let i = local;
      while (i < text.length && word.test(text[i])) i = nextTextBoundary(text, i);
      while (i < text.length && !word.test(text[i])) i = nextTextBoundary(text, i);
      return start + i;
    }
    let i = local;
    while (i > 0 && !word.test(text[i - 1])) i = previousTextBoundary(text, i);
    while (i > 0 && word.test(text[i - 1])) i = previousTextBoundary(text, i);
    return start + i;
  }
  function keydown(event: KeyboardEvent) {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (completion?.handleKey(event)) { event.preventDefault(); return; }
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const command = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "s") return; // Existing document owner handles Save.
    if (command && !event.shiftKey && key === "f") { event.preventDefault(); openSearch(event.altKey); return; }
    if (!mac && command && key === "h") {
      event.preventDefault(); openSearch(true); return;
    }
    if (command && key === "a") { event.preventDefault(); setSelection(0, model.length); return; }
    if (command && (key === "z" || (!mac && key === "y"))) {
      event.preventDefault(); restore(event.shiftKey || key === "y" ? "redo" : "undo"); return;
    }
    if (event.key === "Escape" && !search.panel.hidden) { event.preventDefault(); closeSearch(); return; }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      if (event.key === "Enter") replaceSelection("\n");
      else if (event.shiftKey) {
        if (selection.anchor === selection.head && selection.head > 0 && model.slice(selection.head - 1, selection.head) === "\t") {
          edit(selection.head - 1, selection.head, "");
        }
      } else replaceSelection("\t");
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (readOnly) return;
      deleteSelection(event.key === "Delete", word, command && mac);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    event.preventDefault();
    let next = selection.head;
    let keepX: number | undefined;
    const row = layout.rowForOffset(next), line = model.getLine(row.line);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const forward = event.key === "ArrowRight";
      next = command && mac ? line[forward ? "to" : "from"]
        : !event.shiftKey && selection.anchor !== selection.head
          ? (forward ? Math.max(selection.anchor, selection.head) : Math.min(selection.anchor, selection.head))
          : word ? wordBoundary(next, forward) : boundary(next, forward);
    } else if (event.key === "Home" || event.key === "End") {
      next = command ? (event.key === "Home" ? 0 : model.length) : line.from + (event.key === "Home" ? row.start : row.end);
    } else if (command && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      next = event.key === "ArrowUp" ? 0 : model.length;
    } else {
      const direction = event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1;
      const distance = event.key.startsWith("Page") ? Math.max(1, Math.floor(viewport.clientHeight / lineHeight) - 1) : 1;
      keepX = preferredX ?? layout.xAt(line.text.slice(row.start, row.end), Math.max(0, next - line.from - row.start));
      const target = layout.rowAt(row.index + direction * distance), targetLine = model.getLine(target.line);
      next = targetLine.from + target.start + layout.columnAt(targetLine.text.slice(target.start, target.end), keepX);
    }
    setSelection(event.shiftKey ? selection.anchor : next, next);
    preferredX = keepX;
  }
  function positionAt(clientX: number, clientY: number) {
    const rect = viewport.getBoundingClientRect();
    const row = layout.rowAt(Math.floor((clientY - rect.top + viewport.scrollTop - padding) / lineHeight));
    const line = model.getLine(row.line);
    return line.from + row.start + layout.columnAt(line.text.slice(row.start, row.end), clientX - rect.left - textLeft);
  }
  function dragTick() {
    if (!drag || destroyed) { dragFrame = 0; return; }
    const rect = viewport.getBoundingClientRect();
    const dy = drag.y < rect.top ? drag.y - rect.top : drag.y > rect.bottom ? drag.y - rect.bottom : 0;
    if (dy) viewport.scrollTop += Math.max(-64, Math.min(64, dy));
    selection.head = positionAt(drag.x, Math.max(rect.top, Math.min(rect.bottom, drag.y)));
    syncInput(); render();
    dragFrame = requestAnimationFrame(dragTick);
  }
  function searchPattern(query: string, options: SearchOptions = {}) {
    if (!query) return undefined;
    let pattern = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (options.wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
    return new RegExp(pattern, `gmu${options.caseSensitive ? "" : "i"}`);
  }
  function find(query: string, backward = false, options: SearchOptions = {}) {
    const expression = searchPattern(query, options);
    if (!expression) return false;
    const text = model.getText();
    const start = backward ? Math.min(selection.anchor, selection.head) : Math.max(selection.anchor, selection.head);
    let found: RegExpExecArray | null = null;
    if (!backward) {
      expression.lastIndex = start;
      found = expression.exec(text);
      if (!found) { expression.lastIndex = 0; found = expression.exec(text); }
    } else {
      let match: RegExpExecArray | null;
      while ((match = expression.exec(text))) {
        if (match.index >= start) break;
        found = match;
        if (!match[0].length) expression.lastIndex = nextTextBoundary(text, expression.lastIndex);
      }
      if (!found) {
        expression.lastIndex = 0;
        while ((match = expression.exec(text))) {
          found = match;
          if (!match[0].length) {
            if (expression.lastIndex >= text.length) break;
            expression.lastIndex = nextTextBoundary(text, expression.lastIndex);
          }
        }
      }
    }
    if (!found) return false;
    setSelection(found.index, found.index + found[0].length);
    return true;
  }
  function createSearchPanel() {
    const panel = document.createElement("div");
    panel.className = "plain-text-search";
    panel.hidden = true;
    panel.setAttribute("role", "search");
    const query = document.createElement("input");
    query.type = "search"; query.placeholder = "查找"; query.setAttribute("aria-label", "查找文本");
    const replacement = document.createElement("input");
    replacement.placeholder = "替换为"; replacement.setAttribute("aria-label", "替换文本");
    const status = document.createElement("span"); status.setAttribute("role", "status");
    function button(label: string, action: () => void) {
      const element = document.createElement("button"); element.type = "button"; element.textContent = label;
      on(element, "click", () => guard(action)); panel.append(element); return element;
    }
    const flags: {caseSensitive?: HTMLInputElement; regexp?: HTMLInputElement; wholeWord?: HTMLInputElement} = {};
    const options = () => Object.fromEntries(Object.entries(flags).map(([name, input]) => [name, input?.checked])) as SearchOptions;
    const searchNext = (backward = false) => {
      try { status.textContent = find(query.value, backward, options()) ? "" : "未找到匹配项"; }
      catch { status.textContent = "查找表达式无效"; }
    };
    panel.append(query);
    button("上一个", () => searchNext(true)); button("下一个", () => searchNext());
    panel.append(replacement);
    const replace = button("替换", () => {
      if (readOnly) return;
      const pattern = searchPattern(query.value, options());
      const selected = model.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
      const match = pattern?.exec(selected);
      if (match && match.index === 0 && match[0].length === selected.length) {
        replaceSelection(options().regexp ? selected.replace(pattern!, replacement.value) : replacement.value);
      }
      searchNext();
    });
    const replaceAll = button("全部替换", () => {
      if (readOnly) return;
      const pattern = searchPattern(query.value, options());
      if (!pattern) return;
      const before = model.getText();
      const inserted = normalizeInsertedText(replacement.value, model.lineSeparator);
      const after = options().regexp ? before.replace(pattern, inserted) : before.replace(pattern, () => inserted);
      if (before !== after) edit(0, model.length, after, undefined, undefined, false, true);
    });
    for (const [name, label] of [["caseSensitive", "区分大小写"], ["regexp", "正则表达式"], ["wholeWord", "全词匹配"]] as const) {
      const wrapper = document.createElement("label"), checkbox = document.createElement("input");
      checkbox.type = "checkbox"; flags[name] = checkbox; wrapper.append(checkbox, label); panel.append(wrapper);
    }
    panel.append(status); button("关闭查找", closeSearch);
    on(query, "keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); searchNext(event.shiftKey); }
      if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
    });
    on(replacement, "keydown", event => { if (event.key === "Escape") closeSearch(); });
    return {panel, query, replacement, replace, replaceAll};
  }
  function openSearch(replace = false) {
    search.panel.hidden = false;
    const selected = model.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
    if (selected && selected.length < 1024 && !/[\r\n]/.test(selected)) search.query.value = selected;
    (replace ? search.replacement : search.query).focus();
    search.query.select();
    scheduleRender();
  }
  function closeSearch() { search.panel.hidden = true; input.focus({preventScroll: true}); scheduleRender(); }

  on(viewport, "scroll", scheduleRender);
  on(input, "keydown", event => guard(() => keydown(event)));
  on(input, "beforeinput", event => guard(() => {
    if (readOnly) { event.preventDefault(); return; }
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault(); restore(event.inputType === "historyUndo" ? "undo" : "redo");
    } else if (!composing && (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")) {
      event.preventDefault(); replaceSelection("\n");
    } else if (!composing && !event.isComposing && event.inputType.startsWith("delete")
      && (bufferReplacesSelection || /^delete(Content|Word|SoftLine)(Backward|Forward)$/.test(event.inputType))) {
      event.preventDefault();
      deleteSelection(event.inputType.endsWith("Forward"), event.inputType.includes("Word"), event.inputType.includes("SoftLine"));
    }
  }));
  on(input, "input", event => guard(() => {
    const changed = applyInput();
    if (changed && !composing && !event.isComposing && !compositionTimer
      && (event.inputType === "insertText" || event.inputType === "insertReplacementText" || event.inputType.startsWith("delete"))) {
      completion?.request(true);
    }
  }));
  on(input, "compositionstart", () => {
    completion?.close();
    clearTimeout(compositionTimer);
    compositionTimer = 0;
    composing = true;
    compositionId++;
    history.breakGroup();
  });
  on(input, "compositionend", event => guard(() => {
    applyInput(); composing = false; history.breakGroup();
    clearTimeout(compositionTimer);
    compositionTimer = window.setTimeout(() => guard(() => {
      compositionTimer = 0;
      const changed = applyInput();
      syncInput();
      if (event.data || changed) completion?.request(true);
      if (highlights) scheduleRender();
    }), 0);
  }));
  on(input, "focus", scheduleRender);
  on(input, "blur", () => guard(() => {
    completion?.close();
    if (composing) { applyInput(); composing = false; history.breakGroup(); syncInput(); }
    history.breakGroup(); scheduleRender();
  }));
  on(document, "pointerdown", event => guard(() => {
    if (composing && event.target instanceof Node && !root.contains(event.target)) finishComposition(false);
  }), true);
  on(document, "keydown", event => guard(() => {
    if (composing && (event.metaKey || event.ctrlKey) && ["s", "w", "tab"].includes(event.key.toLowerCase())) {
      finishComposition(event.key.toLowerCase() === "s");
    }
  }), true);
  on(input, "copy", event => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", model.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)));
  });
  on(input, "cut", event => guard(() => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", model.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)));
    if (selection.anchor !== selection.head) replaceSelection("");
  }));
  on(input, "paste", event => guard(() => {
    if (!event.clipboardData) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) replaceSelection(text);
  }));
  on(viewport, "pointerdown", event => guard(() => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (composing) { input.blur(); composing = false; }
    const offset = positionAt(event.clientX, event.clientY);
    if (event.detail >= 3) { const line = model.lineAt(offset); setSelection(line.from, line.toWithBreak, false); }
    else if (event.detail === 2) setSelection(wordBoundary(offset, false), wordBoundary(offset, true), false);
    else setSelection(event.shiftKey ? selection.anchor : offset, offset, false);
    input.focus({preventScroll: true});
    viewport.setPointerCapture(event.pointerId);
    drag = {x: event.clientX, y: event.clientY};
  }));
  on(viewport, "contextmenu", () => completion?.close());
  on(viewport, "pointermove", event => {
    if (!drag) return;
    drag = {x: event.clientX, y: event.clientY};
    if (!dragFrame) dragFrame = requestAnimationFrame(dragTick);
  });
  const endDrag = () => { drag = undefined; cancelAnimationFrame(dragFrame); dragFrame = 0; syncInput(); render(); };
  on(viewport, "pointerup", endDrag); on(viewport, "pointercancel", endDrag);
  on(viewport, "dragover", event => { if (!readOnly && event.dataTransfer?.types.includes("text/plain")) event.preventDefault(); });
  on(viewport, "drop", event => guard(() => {
    if (readOnly || !event.dataTransfer?.types.includes("text/plain")) return;
    event.preventDefault(); setSelection(positionAt(event.clientX, event.clientY));
    replaceSelection(event.dataTransfer.getData("text/plain")); input.focus({preventScroll: true});
  }));
  const fontsChanged = () => guard(() => { layout.invalidateMetrics(); configure(); });
  let resize: ResizeObserver | undefined;
  let themeObserver: MutationObserver | undefined;
  try {
    resize = new ResizeObserver(() => guard(configure));
    resize.observe(viewport);
    document.fonts?.addEventListener("loadingdone", fontsChanged);
    // A theme/font change invalidates metrics without replacing content or undo history.
    themeObserver = new MutationObserver(() => {
      const style = getComputedStyle(content);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (font !== measuredFont) guard(configure);
      else scheduleRender();
    });
    themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ["style", "class", "data-ui-theme", "data-ui-theme-id"]});
  } catch (error) {
    resize?.disconnect(); themeObserver?.disconnect();
    document.fonts?.removeEventListener("loadingdone", fontsChanged);
    disposers.forEach(dispose => dispose()); root.replaceChildren();
    throw error;
  }

  const driver = {
    focus() { if (!destroyed) { input.focus({preventScroll: true}); render(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      completion?.destroy();
      highlights?.destroy();
      cancelAnimationFrame(completionFrame);
      cancelAnimationFrame(frame); cancelAnimationFrame(dragFrame); clearTimeout(compositionTimer);
      resize?.disconnect(); themeObserver?.disconnect(); document.fonts?.removeEventListener("loadingdone", fontsChanged);
      disposers.forEach(dispose => dispose()); root.replaceChildren(); drivers.delete(root);
    },
    setReadOnly(value: boolean) {
      if (value && !readOnly && composing) finishComposition(false);
      if (value) completion?.close();
      readOnly = value; input.readOnly = value; input.setAttribute("aria-readonly", String(value));
      search.replace.disabled = value; search.replaceAll.disabled = value; render();
    },
    replaceContent(text: string) {
      if (destroyed || text === model.getText()) return;
      completion?.close();
      highlights?.clear();
      clearTimeout(compositionTimer);
      compositionTimer = 0;
      composing = false;
      model = createPlainTextModel(text); history = createPlainTextHistory(model);
      layout = new TextLayout(model, document.createElement("canvas"));
      selection = {anchor: Math.min(selection.anchor, model.length), head: Math.min(selection.head, model.length)};
      configure(); syncInput();
    },
    getContent() { return model.getText(); },
    flushContent() {
      if (destroyed) throw new Error("纯文本编辑器已关闭。");
      if (composing) finishComposition();
      else if (!readOnly) applyInput();
      return model.getText();
    },
    getSelection() { return {...selection}; },
    setSelection,
    setCompletion,
    setHighlights(source?: EditorHighlights) {
      if (destroyed || source === highlightSource) return;
      highlights?.destroy();
      highlights = source && createPlainTextHighlights(source, scheduleRender);
      highlightSource = source;
      scheduleRender();
    },
    openCompletion,
    canComplete() { return !readOnly && !composing && (completion?.isAvailable() ?? false); },
    getDebugState() {
      return {length: model.length, lineCount: model.lineCount, renderedLines: layer.childElementCount,
        selection: {...selection}, readOnly, visualRows: layout.rowCount};
    },
    undo() { guard(() => restore("undo")); },
    redo() { guard(() => restore("redo")); },
    find,
    replaceSelection(text: string) { guard(() => replaceSelection(text)); },
    openSearch,
  };
  try { configure(); syncInput(); drivers.set(root, driver); }
  catch (error) { driver.destroy(); throw error; }
  return driver;
}
