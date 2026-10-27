/**
 * A line-indexed source model for plain text. It keeps raw UTF-16 offsets so untouched BOMs,
 * line endings (including mixed endings), and trailing blank lines survive a round trip.
 * The source is split into small line blocks once; an edit reparses only the blocks it touches.
 */

export type PlainTextSelection = Readonly<{anchor: number; head: number}>;

export type PlainTextLine = Readonly<{
  /** Zero-based logical line number. */
  number: number;
  /** Raw UTF-16 offset where this line begins. */
  from: number;
  /** Raw UTF-16 offset where line content ends, before its line break. */
  to: number;
  /** Raw UTF-16 offset after the line break, or `to` for the final line. */
  toWithBreak: number;
  /** UTF-16 column for `lineAt`; zero for `getLine`. */
  column: number;
  /** Text without the line break. */
  text: string;
}>;

export type PlainTextChange = Readonly<{
  from: number;
  deleted: string;
  insert: string;
}>;

type LineBlock = {
  text: string;
  starts: number[];
  textEnds: number[];
  ends: number[];
};

const DEFAULT_BLOCK_LINE_LIMIT = 128;

function lineBreakEnd(text: string, from: number): {textEnd: number; end: number} {
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 10) return {textEnd: index, end: index + 1};
    if (code === 13) return {textEnd: index, end: index + (text.charCodeAt(index + 1) === 10 ? 2 : 1)};
    index++;
  }
  return {textEnd: text.length, end: text.length};
}

function parseBlocks(source: string, lineLimit: number, includeTrailingEmpty: boolean): LineBlock[] {
  const blocks: LineBlock[] = [];
  if (source.length === 0 && !includeTrailingEmpty) return blocks;
  let lineStart = 0;
  let done = false;

  while (!done) {
    const blockStart = lineStart;
    const starts: number[] = [];
    const textEnds: number[] = [];
    const ends: number[] = [];

    while (starts.length < lineLimit && !done) {
      if (lineStart === source.length && source.length > 0 && !includeTrailingEmpty) {
        done = true;
        break;
      }
      starts.push(lineStart - blockStart);
      const line = lineBreakEnd(source, lineStart);
      textEnds.push(line.textEnd - blockStart);
      ends.push(line.end - blockStart);
      if (line.end === source.length && line.textEnd === source.length) {
        // The final unterminated line (or sole empty line) is complete.
        lineStart = line.end;
        done = true;
      } else if (line.end === source.length) {
        // A trailing separator introduces one more line only at the document end.
        lineStart = line.end;
        if (includeTrailingEmpty) lineStart = source.length;
        else done = true;
      } else {
        lineStart = line.end;
      }
    }

    if (starts.length) blocks.push({text: source.slice(blockStart, lineStart), starts, textEnds, ends});
  }

  return blocks;
}

function checkedOffset(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be an integer between 0 and ${max}.`);
  }
  return value;
}

/** The first line separator in the source, or LF for a source without a separator. */
export function detectPlainTextLineSeparator(content: string): "\r\n" | "\r" | "\n" {
  const found = lineBreakEnd(content, 0);
  if (found.textEnd === content.length) return "\n";
  if (content.charCodeAt(found.textEnd) === 13 && content.charCodeAt(found.textEnd + 1) === 10) return "\r\n";
  return content.charCodeAt(found.textEnd) === 13 ? "\r" : "\n";
}

/** Normalize newly pasted or typed line breaks to the source's established separator. */
export function normalizeInsertedText(text: string, separator: "\r\n" | "\r" | "\n" = "\n"): string {
  return text.replace(/\r\n|\r|\n/g, separator);
}

/** A mutable text buffer with a block-level line index and raw source preservation. */
export function createPlainTextModel(content: string, options: {blockLineLimit?: number} = {}) {
  const lineLimit = options.blockLineLimit ?? DEFAULT_BLOCK_LINE_LIMIT;
  if (!Number.isInteger(lineLimit) || lineLimit < 16 || lineLimit > 4096) {
    throw new RangeError("blockLineLimit must be an integer between 16 and 4096.");
  }

  let blocks = parseBlocks(content, lineLimit, true);
  let linePrefixes: number[] = [];
  let charPrefixes: number[] = [];
  let cachedText: string | undefined = content;
  const lineSeparator = detectPlainTextLineSeparator(content);

  function rebuildPrefixes() {
    linePrefixes = new Array(blocks.length + 1);
    charPrefixes = new Array(blocks.length + 1);
    linePrefixes[0] = 0;
    charPrefixes[0] = 0;
    for (let index = 0; index < blocks.length; index++) {
      linePrefixes[index + 1] = linePrefixes[index] + blocks[index].starts.length;
      charPrefixes[index + 1] = charPrefixes[index] + blocks[index].text.length;
    }
  }

  function findBlock(prefixes: readonly number[], value: number, atEnd: boolean): number {
    if (atEnd) return blocks.length - 1;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (prefixes[middle + 1] <= value) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, blocks.length - 1);
  }

  function lineInBlock(block: LineBlock, local: number, lineNumber: number, blockStart: number): PlainTextLine {
    const from = blockStart + block.starts[local];
    const to = blockStart + block.textEnds[local];
    const toWithBreak = blockStart + block.ends[local];
    return {number: lineNumber + local, from, to, toWithBreak, column: 0, text: block.text.slice(block.starts[local], block.textEnds[local])};
  }

  function lineIndexAtOffset(block: LineBlock, relativeOffset: number): number {
    let low = 0;
    let high = block.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (block.ends[middle] <= relativeOffset && middle + 1 < block.starts.length) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  rebuildPrefixes();

  return {
    get length() { return charPrefixes[blocks.length]; },
    get lineCount() { return linePrefixes[blocks.length]; },
    get lineSeparator() { return lineSeparator; },

    /** Reassembles and caches the complete original/raw source. */
    getText(): string {
      if (cachedText === undefined) cachedText = blocks.map(block => block.text).join("");
      return cachedText;
    },

    slice(from: number, to: number): string {
      checkedOffset(from, charPrefixes[blocks.length], "from");
      checkedOffset(to, charPrefixes[blocks.length], "to");
      if (to < from) throw new RangeError("to must not be less than from.");
      if (from === to) return "";

      let blockIndex = findBlock(charPrefixes, from, from === charPrefixes[blocks.length]);
      let blockStart = charPrefixes[blockIndex];
      const parts: string[] = [];
      while (blockIndex < blocks.length && blockStart < to) {
        const block = blocks[blockIndex];
        const localFrom = Math.max(0, from - blockStart);
        const localTo = Math.min(block.text.length, to - blockStart);
        if (localTo > localFrom) parts.push(block.text.slice(localFrom, localTo));
        blockStart += block.text.length;
        blockIndex++;
      }
      return parts.join("");
    },

    getLine(number: number): PlainTextLine {
      checkedOffset(number, linePrefixes[blocks.length] - 1, "line number");
      const blockIndex = findBlock(linePrefixes, number, false);
      return lineInBlock(blocks[blockIndex], number - linePrefixes[blockIndex], linePrefixes[blockIndex], charPrefixes[blockIndex]);
    },

    lineAt(offset: number): PlainTextLine {
      checkedOffset(offset, charPrefixes[blocks.length], "offset");
      const blockIndex = findBlock(charPrefixes, offset, offset === charPrefixes[blocks.length]);
      const block = blocks[blockIndex];
      const local = lineIndexAtOffset(block, offset - charPrefixes[blockIndex]);
      const line = lineInBlock(block, local, linePrefixes[blockIndex], charPrefixes[blockIndex]);
      return {...line, column: Math.max(0, Math.min(offset - line.from, line.to - line.from))};
    },

    offsetAt(lineNumber: number, column: number): number {
      const line = this.getLine(lineNumber);
      checkedOffset(column, line.text.length, "column");
      return line.from + column;
    },

    /** Replaces raw UTF-16 offsets without normalizing the inserted bytes or separators. */
    replace(from: number, to: number, insert: string): PlainTextChange {
      checkedOffset(from, charPrefixes[blocks.length], "from");
      checkedOffset(to, charPrefixes[blocks.length], "to");
      if (to < from) throw new RangeError("to must not be less than from.");
      if (typeof insert !== "string") throw new TypeError("insert must be a string.");

      const deleted = this.slice(from, to);
      if (deleted === insert) return {from, deleted, insert};

      const firstBlock = findBlock(charPrefixes, from, from === charPrefixes[blocks.length]);
      const lastBlock = findBlock(charPrefixes, to, to === charPrefixes[blocks.length]);
      // Include adjacent blocks because an edit at a block edge can join or split a CRLF.
      // For example, inserting LF after a previous block's trailing CR must be parsed as one
      // separator instead of a new empty line. This still bounds reparsing to three line blocks.
      const regionFirstBlock = Math.max(0, firstBlock - 1);
      const regionLastBlock = Math.min(blocks.length - 1, lastBlock + 1);
      const regionStart = charPrefixes[regionFirstBlock];
      const regionEnd = charPrefixes[regionLastBlock + 1];
      const replacement = this.slice(regionStart, from) + insert + this.slice(to, regionEnd);
      const parsed = parseBlocks(replacement, lineLimit, regionEnd === charPrefixes[blocks.length]);
      blocks = blocks.slice(0, regionFirstBlock).concat(parsed, blocks.slice(regionLastBlock + 1));
      if (!blocks.length) blocks = parseBlocks("", lineLimit, true);
      cachedText = undefined;
      rebuildPrefixes();
      return {from, deleted, insert};
    },
  };
}

export type PlainTextModel = ReturnType<typeof createPlainTextModel>;
