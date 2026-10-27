/** Count JavaScript `\s`-filtered Unicode code points without allocating a filtered copy or an array. */
export function countDocumentCharacters(text: string): number {
  let count = 0;
  let pendingHighSurrogate = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code)) continue;

    if (pendingHighSurrogate) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        count++;
        pendingHighSurrogate = false;
        continue;
      }
      count++;
    }

    pendingHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (!pendingHighSurrogate) count++;
  }
  if (pendingHighSurrogate) count++;
  return count;
}

function isWhitespace(code: number): boolean {
  return code >= 0x0009 && code <= 0x000d
    || code === 0x0020 || code === 0x00a0 || code === 0x1680
    || code >= 0x2000 && code <= 0x200a
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
