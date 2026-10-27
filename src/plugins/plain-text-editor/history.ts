import type {PlainTextModel, PlainTextSelection} from "./textModel";

export type PlainTextHistoryEntry = {
  from: number;
  deleted: string;
  insert: string;
  beforeSelection: PlainTextSelection;
  afterSelection: PlainTextSelection;
  group?: string;
  epoch: number;
};

export type PlainTextHistoryOptions = Readonly<{
  maxEntries?: number;
  maxBytes?: number;
}>;

export type PlainTextHistoryOperation = Readonly<{
  from: number;
  to: number;
  insert: string;
  selection: PlainTextSelection;
}>;

function sameSelection(left: PlainTextSelection, right: PlainTextSelection): boolean {
  return left.anchor === right.anchor && left.head === right.head;
}

function canMerge(previous: PlainTextHistoryEntry, next: PlainTextHistoryEntry): boolean {
  if (previous.group === undefined || previous.group !== next.group || previous.epoch !== next.epoch
    || !sameSelection(previous.afterSelection, next.beforeSelection)) return false;

  // Composition updates and normal typing often replace part of the text inserted by the
  // previous event. Rebase that replacement into the original operation when it stays inside it.
  return next.from >= previous.from && next.from + next.deleted.length <= previous.from + previous.insert.length;
}

/** Undo and redo history that stores only changed slices, never a snapshot of the whole file. */
export function createPlainTextHistory(
  model: PlainTextModel,
  options: PlainTextHistoryOptions = {},
) {
  const maxEntries = options.maxEntries ?? 500;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer.");

  const entries: PlainTextHistoryEntry[] = [];
  let cursor = 0;
  let bytes = 0;
  let epoch = 0;

  function entryBytes(entry: Pick<PlainTextHistoryEntry, "deleted" | "insert">): number {
    return (entry.deleted.length + entry.insert.length) * 2;
  }

  function prune() {
    while (entries.length > 1 && (entries.length > maxEntries || bytes > maxBytes)) {
      const removed = entries.shift()!;
      bytes -= entryBytes(removed);
      cursor = Math.max(0, cursor - 1);
    }
  }

  return {
    get undoDepth() { return cursor; },
    get redoDepth() { return entries.length - cursor; },
    get retainedBytes() { return bytes; },

    /** Describes the source replacement that undo will apply, without changing the model. */
    peekUndo(): PlainTextHistoryOperation | undefined {
      const entry = entries[cursor - 1];
      if (!entry) return undefined;
      return {from: entry.from, to: entry.from + entry.insert.length, insert: entry.deleted,
        selection: entry.beforeSelection};
    },

    /** Describes the source replacement that redo will apply, without changing the model. */
    peekRedo(): PlainTextHistoryOperation | undefined {
      const entry = entries[cursor];
      if (!entry) return undefined;
      return {from: entry.from, to: entry.from + entry.deleted.length, insert: entry.insert,
        selection: entry.afterSelection};
    },

    /** Applies one edit and records enough source to reverse it. Offsets use raw UTF-16 units. */
    apply(
      from: number,
      to: number,
      insert: string,
      selection: Readonly<{
        before?: PlainTextSelection;
        after?: PlainTextSelection;
        group?: string;
      }> = {},
    ): PlainTextHistoryEntry {
      const deleted = model.slice(from, to);
      const beforeSelection = selection.before ?? {anchor: from, head: to};
      const caret = from + insert.length;
      const afterSelection = selection.after ?? {anchor: caret, head: caret};
      const change: PlainTextHistoryEntry = {
        from,
        deleted,
        insert,
        beforeSelection,
        afterSelection,
        group: selection.group,
        epoch,
      };

      model.replace(from, to, insert);
      if (deleted === insert) return change;

      if (cursor < entries.length) {
        for (let index = cursor; index < entries.length; index++) bytes -= entryBytes(entries[index]);
        entries.length = cursor;
      }

      const previous = entries[cursor - 1];
      if (previous && canMerge(previous, change)) {
        bytes -= entryBytes(previous);
        const localFrom = from - previous.from;
        previous.insert = previous.insert.slice(0, localFrom) + insert
          + previous.insert.slice(localFrom + deleted.length);
        previous.afterSelection = afterSelection;
        bytes += entryBytes(previous);
        prune();
        return previous;
      }

      entries.push(change);
      cursor++;
      bytes += entryBytes(change);
      prune();
      return change;
    },

    /** Reverses the latest edit and returns the selection to restore. */
    undo(): PlainTextSelection | undefined {
      if (cursor === 0) return undefined;
      const entry = entries[--cursor];
      model.replace(entry.from, entry.from + entry.insert.length, entry.deleted);
      epoch++;
      return entry.beforeSelection;
    },

    /** Reapplies the next edit and returns the selection to restore. */
    redo(): PlainTextSelection | undefined {
      if (cursor >= entries.length) return undefined;
      const entry = entries[cursor++];
      model.replace(entry.from, entry.from + entry.deleted.length, entry.insert);
      epoch++;
      return entry.afterSelection;
    },

    /** Prevents subsequent changes from joining the current typing or composition group. */
    breakGroup() {
      epoch++;
    },

    /** Clears undo and redo state after replacing the document from outside the editor. */
    clear() {
      entries.length = 0;
      cursor = 0;
      bytes = 0;
      epoch++;
    },
  };
}
