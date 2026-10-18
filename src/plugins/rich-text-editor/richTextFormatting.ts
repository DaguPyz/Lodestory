/** True when a value can be represented as one user-selected font family. */
export function isRichFontFamily(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Array.from(value).length <= 1024
    && !/\p{Cc}/u.test(value);
}

/**
 * Serializes a font family as one CSS string token. The quotes keep punctuation
 * such as commas, braces, and semicolons inside the family name.
 */
export function quoteFontFamily(family: string): string {
  let quoted = '"';
  for (const character of family) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"' || character === "\\") {
      quoted += `\\${character}`;
    } else if (/\p{Cc}/u.test(character)) {
      quoted += `\\${(codePoint === 0 ? 0xfffd : codePoint).toString(16).toUpperCase()} `;
    } else {
      quoted += character;
    }
  }
  return `${quoted}"`;
}

type CssEscape = { value: string; next: number };

function isHexDigit(character: string | undefined): boolean {
  return character !== undefined && /^[\da-f]$/i.test(character);
}

function isCssWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function escapedCodePoint(codePoint: number): string {
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "\ufffd";
  }
  return String.fromCodePoint(codePoint);
}

function readCssEscape(input: string, index: number, inString: boolean): CssEscape | undefined {
  if (input[index] !== "\\" || index + 1 >= input.length) return undefined;
  const nextCharacter = input[index + 1];
  if (nextCharacter === "\n" || nextCharacter === "\f" || nextCharacter === "\r") {
    if (!inString) return undefined;
    return { value: "", next: index + (nextCharacter === "\r" && input[index + 2] === "\n" ? 3 : 2) };
  }

  if (!isHexDigit(nextCharacter)) return { value: nextCharacter, next: index + 2 };

  let end = index + 1;
  while (end < input.length && end < index + 7 && isHexDigit(input[end])) end += 1;
  const codePoint = Number.parseInt(input.slice(index + 1, end), 16);
  if (input[end] === "\r" && input[end + 1] === "\n") end += 2;
  else if (isCssWhitespace(input[end])) end += 1;
  return { value: escapedCodePoint(codePoint), next: end };
}

function parseQuotedFamily(input: string): string | undefined {
  const quote = input[0];
  let value = "";
  let index = 1;
  while (index < input.length) {
    const character = input[index];
    if (character === quote) {
      return input.slice(index + 1).trim() === "" ? value : undefined;
    }
    if (character === "\n" || character === "\r" || character === "\f" || /\p{Cc}/u.test(character)) {
      return undefined;
    }
    if (character === "\\") {
      const escape = readCssEscape(input, index, true);
      if (!escape) return undefined;
      value += escape.value;
      index = escape.next;
      continue;
    }
    value += character;
    index += 1;
  }
  return undefined;
}

function isNameStart(character: string | undefined): boolean {
  return character !== undefined && (character === "_" || /[a-z]/i.test(character) || character.codePointAt(0)! >= 0x80);
}

function isNameCharacter(character: string | undefined): boolean {
  return isNameStart(character) || character === "-" || (character !== undefined && /[0-9]/.test(character));
}

function parseUnquotedFamily(input: string): string | undefined {
  let index = 0;
  const words: string[] = [];
  while (index < input.length) {
    if (input[index] === "," || input[index] === "'" || input[index] === '"') return undefined;
    let word = "";
    const first = input[index];
    if (first === "\\") {
      const escape = readCssEscape(input, index, false);
      if (!escape) return undefined;
      word += escape.value;
      index = escape.next;
    } else if (first === "-" && (input[index + 1] === "-" || isNameStart(input[index + 1]) || input[index + 1] === "\\")) {
      word += "-";
      index += 1;
    } else if (isNameStart(first)) {
      word += first;
      index += 1;
    } else {
      return undefined;
    }

    while (index < input.length) {
      if (isNameCharacter(input[index])) {
        word += input[index];
        index += 1;
      } else if (input[index] === "\\") {
        const escape = readCssEscape(input, index, false);
        if (!escape) return undefined;
        word += escape.value;
        index = escape.next;
      } else {
        break;
      }
    }
    words.push(word);
    if (index === input.length) break;
    if (!isCssWhitespace(input[index])) return undefined;
    while (isCssWhitespace(input[index])) index += 1;
    if (index < input.length && input[index] === ",") return undefined;
  }
  return words.length ? words.join(" ") : undefined;
}

/** Parses one CSS font-family value, returning undefined for invalid or list values. */
export function parseFontFamily(css: string): string | undefined {
  if (typeof css !== "string") return undefined;
  const input = css.trim();
  if (!input) return undefined;
  const parsed = input[0] === "'" || input[0] === '"'
    ? parseQuotedFamily(input)
    : parseUnquotedFamily(input);
  return parsed !== undefined && isRichFontFamily(parsed) ? parsed : undefined;
}
