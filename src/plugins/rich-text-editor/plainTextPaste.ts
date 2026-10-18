export type PlainTextPasteSelection = Readonly<{index: number; length: number}>;
export type PlainTextPasteOperation = Readonly<{retain: number} | {delete: number} | {insert: string}>;
export type PlainTextPaste = Readonly<{
  ops: readonly PlainTextPasteOperation[];
  cursorIndex: number;
}>;

/** Build one replacement Delta for a plain-text paste, including Quill's normalized cursor offset. */
export function createPlainTextPasteDelta(
  selection: PlainTextPasteSelection,
  clipboardText: string,
): PlainTextPaste | undefined {
  if (!Number.isInteger(selection.index) || selection.index < 0
    || !Number.isInteger(selection.length) || selection.length < 0) return undefined;

  const text = clipboardText.replace(/\r\n?/g, "\n");
  if (text.length === 0) return undefined;

  const ops: PlainTextPasteOperation[] = [];
  if (selection.index > 0) ops.push(Object.freeze({retain: selection.index}));
  if (selection.length > 0) ops.push(Object.freeze({delete: selection.length}));
  ops.push(Object.freeze({insert: text}));

  return Object.freeze({
    ops: Object.freeze(ops),
    cursorIndex: selection.index + text.length,
  });
}
