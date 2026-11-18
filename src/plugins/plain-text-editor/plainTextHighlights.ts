import type {EditorHighlight, EditorHighlightPreview, EditorHighlights} from "@lodestory/sdk/body-editor";

// Cover words that cross the viewport edge and reuse nearby matches when scrolling.
const context = 128;
type Window = {from: number; to: number};

export function createPlainTextHighlights(source: EditorHighlights, repaint: () => void) {
  let ranges: readonly EditorHighlight[] = [];
  let covered: Window | undefined;
  let pending: (Window & {controller: AbortController}) | undefined;

  function invalidate() {
    pending?.controller.abort();
    pending = covered = undefined;
  }
  function clear() {
    invalidate();
    ranges = [];
  }
  const unsubscribe = source.subscribe(() => { clear(); repaint(); });

  return {
    ranges: () => ranges,
    clear,
    edit(from: number, to: number, insertedLength: number) {
      invalidate();
      if (!ranges.length) return;
      const delta = insertedLength - (to - from);
      ranges = ranges.flatMap(range => {
        if (range.to <= from - context) return [range];
        if (range.from >= to + context) return [delta ? {...range, from: range.from + delta, to: range.to + delta} : range];
        return [];
      });
    },
    request(from: number, to: number, length: number, read: (from: number, to: number) => string) {
      if (from >= to || !source.isAvailable()) return;
      if (pending && pending.from <= from && to <= pending.to) return;
      pending?.controller.abort();
      pending = undefined;
      if (covered && covered.from <= from && to <= covered.to) return;
      const start = Math.max(0, from - 2 * context);
      const end = Math.min(length, to + 2 * context);
      const request = {from: start === 0 ? 0 : start + context,
        to: end === length ? length : end - context, controller: new AbortController()};
      pending = request;
      const text = read(start, end);
      const {signal} = request.controller;
      void Promise.resolve().then(() => signal.aborted ? [] : source.query(text, signal)).then(result => {
        if (pending !== request || signal.aborted) return;
        pending = undefined;
        covered = request;
        const next: EditorHighlight[] = [];
        let previousEnd = 0;
        for (const item of result) {
          if (!Number.isInteger(item.from) || !Number.isInteger(item.to) || item.from < previousEnd
            || item.to <= item.from || item.to > text.length) continue;
          previousEnd = item.to;
          const from = item.from + start, to = item.to + start;
          if (to <= request.from || from >= request.to) continue;
          const color = /^#[0-9a-f]{6}$/i.test(item.color ?? "") ? item.color : undefined;
          next.push({from, to, color, preview: item.preview});
        }
        const changed = next.length !== ranges.length || next.some((range, index) => {
          const previous = ranges[index];
          return range.from !== previous.from || range.to !== previous.to || range.color !== previous.color
            || range.preview?.key !== previous.preview?.key;
        });
        ranges = next;
        if (changed) repaint();
      }).catch(() => { if (pending === request) pending = undefined; });
    },
    destroy() {
      try { unsubscribe(); } finally { clear(); }
    },
  };
}

export function appendStyledText(element: HTMLElement, text: string, rowFrom: number,
  selection: {from: number; to: number; className: string}, targetByElement: WeakMap<Element, EditorHighlightPreview>,
  ranges: readonly EditorHighlight[] = []) {
  let cursor = rowFrom;
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].to <= rowFrom) low = middle + 1;
    else high = middle;
  }
  let index = low;
  function appendThrough(to: number, parent: HTMLElement) {
    if (cursor === to) return;
    parent.append(text.slice(cursor - rowFrom, to - rowFrom));
    cursor = to;
  }
  function appendStyledThrough(to: number, parent = element) {
    if (cursor === to) return;
    for (; index < ranges.length; index++) {
      const match = ranges[index];
      if (match.from >= to) break;
      if (match.to <= cursor) continue;
      appendThrough(Math.max(cursor, match.from), parent);
      const end = Math.min(to, match.to);
      if (parent === element || match.preview) {
        const span = document.createElement("span");
        if (parent === element) {
          span.className = "plain-text-highlight";
          if (match.color) span.style.setProperty("--plain-text-highlight-color", match.color);
        }
        if (match.preview) {
          span.dataset.inspectable = "";
          targetByElement.set(span, match.preview);
        }
        appendThrough(end, span);
        parent.append(span);
      } else appendThrough(end, parent);
      if (match.to > to) break;
    }
    appendThrough(to, parent);
  }

  if (selection.from < selection.to) {
    appendStyledThrough(selection.from);
    const mark = document.createElement("span");
    mark.className = selection.className;
    appendStyledThrough(selection.to, mark);
    element.append(mark);
  }
  appendStyledThrough(rowFrom + text.length);
}
