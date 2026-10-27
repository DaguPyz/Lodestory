import type {PlainTextModel} from "./textModel";

/** Offsets in a displayed row are relative to its logical source line. */
export type TextRow = {line: number; start: number; end: number; index: number};

/** A small prefix-sum index maps scroll positions to lines without visiting offscreen text. */
export class TextLayout {
  private rows: (number[] | undefined)[] = [];
  private counts: number[] = [];
  private sums = new Float64Array(0);
  private widths = new Map<string, number>();
  private width = 600;
  private font = "18px serif";
  private context: CanvasRenderingContext2D;
  private tabWidth = 72;
  private wideWidth = 18;
  private asciiWidths = new Float64Array(128);

  constructor(private model: PlainTextModel, canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建纯文本排版上下文。");
    this.context = context;
  }

  invalidateMetrics() { this.font = ""; }

  configure(width: number, font: string) {
    if (this.rows.length && this.width === width && this.font === font) return false;
    this.width = Math.max(1, width);
    this.font = font;
    this.context.font = font;
    if ("fontKerning" in this.context) this.context.fontKerning = "none";
    this.widths.clear();
    this.tabWidth = Math.max(1, this.context.measureText(" ").width * 4);
    this.wideWidth = this.context.measureText("汉").width;
    for (let i = 0; i < 128; i++) this.asciiWidths[i] = this.context.measureText(String.fromCharCode(i)).width;
    this.rebuild();
    return true;
  }

  rebuild() {
    // Estimate offscreen line heights without creating glyph layouts. Actual wraps are
    // resolved only when a line is displayed or receives the caret.
    this.rows = new Array(this.model.lineCount);
    this.counts = Array.from({length: this.model.lineCount}, (_, line) => this.estimate(this.model.getLine(line).text));
    this.reindex();
  }

  /** Only edited source lines are wrapped again; existing line layouts remain valid. */
  update(firstLine: number, oldLineCount: number, newLineCount: number) {
    const replacement = Array.from({length: newLineCount}, (_, i) => this.estimate(this.model.getLine(firstLine + i).text));
    if (oldLineCount === newLineCount) {
      for (let local = 0; local < newLineCount; local++) {
        const line = firstLine + local;
        const delta = replacement[local] - this.counts[line];
        this.counts[line] = replacement[local];
        this.rows[line] = undefined;
        for (let i = line + 1; i < this.sums.length; i += i & -i) this.sums[i] += delta;
      }
      return;
    }
    // splice's argument limit is much smaller than an entire large document.
    this.rows.splice(firstLine, oldLineCount);
    this.counts.splice(firstLine, oldLineCount);
    for (let i = replacement.length; i > 0; i -= 4096) {
      const from = Math.max(0, i - 4096);
      this.rows.splice(firstLine, 0, ...new Array<undefined>(i - from).fill(undefined));
      this.counts.splice(firstLine, 0, ...replacement.slice(from, i));
    }
    this.reindex();
  }

  private reindex() {
    this.sums = new Float64Array(this.rows.length + 1);
    for (let i = 1; i < this.sums.length; i++) {
      this.sums[i] += this.counts[i - 1];
      const parent = i + (i & -i);
      if (parent < this.sums.length) this.sums[parent] += this.sums[i];
    }
  }

  get rowCount() { return this.prefix(this.rows.length); }

  private prefix(line: number) {
    let sum = 0;
    for (let i = line; i > 0; i -= i & -i) sum += this.sums[i];
    return sum;
  }

  private estimate(text: string) {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // Ordinary CJK glyphs have the same advance in the document's serif fonts.
      width += code < 128 ? (code === 9 ? this.tabWidth : this.asciiWidths[code])
        : code >= 0x2e80 && code <= 0xffef ? this.wideWidth
          : code >= 0xdc00 && code <= 0xdfff ? 0 : this.wideWidth;
    }
    return Math.max(1, Math.ceil(width / this.width));
  }

  private ensureLine(line: number) {
    let rows = this.rows[line];
    if (!rows) {
      rows = this.wrap(this.model.getLine(line).text);
      this.rows[line] = rows;
      const delta = rows.length - this.counts[line];
      this.counts[line] = rows.length;
      for (let i = line + 1; i < this.sums.length; i += i & -i) this.sums[i] += delta;
    }
    return rows;
  }

  rowAt(index: number): TextRow {
    return this.resolveRow(index);
  }

  private resolveRow(index: number): TextRow {
    const bounded = Math.max(0, Math.min(Math.floor(index), this.rowCount - 1));
    let line = 0;
    let sum = 0;
    let bit = 1;
    while (bit * 2 < this.sums.length) bit *= 2;
    for (; bit; bit >>= 1) {
      const next = line + bit;
      if (next < this.sums.length && sum + this.sums[next] <= bounded) {
        line = next;
        sum += this.sums[next];
      }
    }
    const previousCount = this.counts[line];
    const starts = this.ensureLine(line);
    if (previousCount !== starts.length) return this.resolveRow(index);
    const local = Math.min(starts.length - 1, bounded - sum);
    return {line, start: starts[local], end: starts[local + 1] ?? this.model.getLine(line).text.length, index: bounded};
  }

  rowForOffset(offset: number): TextRow {
    const line = this.model.lineAt(offset);
    const starts = this.ensureLine(line.number);
    let low = 0, high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= line.column) low = middle;
      else high = middle;
    }
    return {line: line.number, start: starts[low], end: starts[low + 1] ?? line.text.length,
      index: this.prefix(line.number) + low};
  }

  private advance(cluster: string, x: number) {
    if (cluster === "\t") return this.tabWidth - (x % this.tabWidth);
    let width = this.widths.get(cluster);
    if (width === undefined) {
      width = this.context.measureText(cluster).width;
      this.widths.set(cluster, width);
    }
    return width;
  }

  private wrap(text: string) {
    const starts = [0];
    let x = 0;
    for (let i = 0; i < text.length;) {
      const end = nextTextBoundary(text, i);
      const cluster = text.slice(i, end);
      let advance = this.advance(cluster, x);
      if (x + advance > this.width && i > starts[starts.length - 1]) {
        starts.push(i);
        x = 0;
        advance = this.advance(cluster, 0);
      }
      x += advance;
      i = end;
    }
    return starts;
  }

  xAt(text: string, end = text.length) {
    let x = 0;
    for (let i = 0; i < end;) {
      const next = nextTextBoundary(text, i);
      x += this.advance(text.slice(i, next), x);
      i = next;
    }
    return x;
  }

  columnAt(text: string, targetX: number) {
    let x = 0;
    for (let i = 0; i < text.length;) {
      const next = nextTextBoundary(text, i);
      const advance = this.advance(text.slice(i, next), x);
      if (targetX < x + advance / 2) return i;
      x += advance;
      i = next;
    }
    return text.length;
  }
}

const mark = /[\p{Mark}\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

/** Keep surrogate pairs, combining marks, emoji modifiers and joined emoji together. */
export function nextTextBoundary(text: string, from: number): number {
  if (from >= text.length) return text.length;
  const first = text.codePointAt(from)!;
  let end = from + (first > 0xffff ? 2 : 1);
  if (first === 13 && text.charCodeAt(end) === 10) return end + 1;
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    const next = text.codePointAt(end);
    if (next !== undefined && next >= 0x1f1e6 && next <= 0x1f1ff) end += 2;
  }
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const size = point > 0xffff ? 2 : 1;
    if (point === 0x200d && end + size < text.length) {
      end += size;
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    } else if (point >= 0x300 && mark.test(text.slice(end, end + size))) end += size;
    else break;
  }
  return end;
}

export function previousTextBoundary(text: string, from: number): number {
  // Keyboard context is bounded by the caller, so even very long lines stay cheap here.
  let previous = 0;
  for (let i = 0; i < from;) {
    previous = i;
    i = nextTextBoundary(text, i);
  }
  return previous;
}
