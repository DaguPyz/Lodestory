/** Match the index's NFKC, case-insensitive search while preserving the original text. */
export function highlightMatches(text: string, query: string): readonly {text: string; matched: boolean}[] {
  const term = query.trim().normalize("NFKC").toLocaleLowerCase();
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  if (!term || !normalized.includes(term)) return [{text, matched: false}];

  // Each normalized code unit points back to its original character and combining marks.
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    const size = match[0].normalize("NFKC").toLocaleLowerCase().length;
    for (let index = 0; index < size; index++) { starts.push(start); ends.push(end); }
  }
  // Unusual normalization across segments needs prefix lengths to locate original boundaries.
  if (starts.length !== normalized.length) {
    starts.length = 0; ends.length = 0;
    let end = 0;
    for (const character of text) {
      const start = end;
      end += character.length;
      const size = text.slice(0, end).normalize("NFKC").toLocaleLowerCase().length;
      if (size <= ends.length) {
        if (ends.length) ends[ends.length - 1] = end;
      } else {
        while (starts.length < size) { starts.push(start); ends.push(end); }
      }
    }
  }

  const ranges: {start: number; end: number}[] = [];
  let from = 0;
  while (from < normalized.length) {
    const index = normalized.indexOf(term, from);
    if (index < 0) break;
    const start = starts[index], end = ends[index + term.length - 1];
    if (start !== undefined && end !== undefined) {
      const last = ranges[ranges.length - 1];
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else ranges.push({start, end});
    }
    from = index + term.length;
  }
  const result: {text: string; matched: boolean}[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) result.push({text: text.slice(offset, range.start), matched: false});
    result.push({text: text.slice(range.start, range.end), matched: true});
    offset = range.end;
  }
  if (offset < text.length) result.push({text: text.slice(offset), matched: false});
  return result;
}
