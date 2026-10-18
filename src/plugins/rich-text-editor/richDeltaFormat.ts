import type {EditorFormat} from "@lodestory/sdk/body-editor";
import {isRichFontFamily} from "./richTextFormatting";

export type RichDeltaAttributes = Readonly<Record<string, boolean | number | string>>;
export type RichDeltaOperation = Readonly<{
  insert: string;
  attributes?: RichDeltaAttributes;
}>;
export type RichDeltaEnvelope = Readonly<{
  format: "quill-delta";
  version: 1;
  ops: readonly RichDeltaOperation[];
}>;

const supportedAttributes = new Set([
  "bold", "italic", "underline", "strike", "header", "list", "blockquote", "link",
  "align", "font", "size", "color", "background",
]);
const emptyDocumentOps: readonly RichDeltaOperation[] = Object.freeze([Object.freeze({insert: "\n"})]);

/** Quill size values are persisted as bounded CSS pixels. */
export function isRichTextSize(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!match) return false;
  const size = Number(match[1]);
  return Number.isFinite(size) && size >= 1 && size <= 256;
}

/** Accept only opaque hex or integer rgb values; other CSS color syntaxes are not persisted. */
export function isRichTextColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return true;
  const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  return !!match && match.slice(1).every(channel => Number(channel) <= 255);
}

/** Parse only the versioned, insert-only document snapshot understood by this editor. */
export function parseRichDeltaEnvelope(content: string): RichDeltaEnvelope {
  if (content === "") return Object.freeze({format: "quill-delta", version: 1, ops: emptyDocumentOps});

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("富文本内容不是有效的 JSON 文档。");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["format", "version", "ops"])
    || value.format !== "quill-delta" || value.version !== 1 || !Array.isArray(value.ops)) {
    throw new Error("富文本格式或版本不受支持，原文已保留。");
  }

  const ops: RichDeltaOperation[] = [];
  let text = "";
  for (const valueOp of value.ops) {
    if (!isRecord(valueOp) || !hasExactKeys(valueOp, ["insert", "attributes"], ["insert"])) {
      throw new Error("富文本快照包含不支持的 Delta 操作，原文已保留。");
    }
    if (typeof valueOp.insert !== "string" || valueOp.insert.length === 0) {
      throw new Error("富文本快照只支持非空文本插入操作，原文已保留。");
    }
    const attributes = parseAttributes(valueOp.attributes);
    text += valueOp.insert;
    ops.push(Object.freeze(attributes ? {insert: valueOp.insert, attributes} : {insert: valueOp.insert}));
  }
  if (!ops.length || !text.endsWith("\n")) {
    throw new Error("富文本快照缺少 Quill 文档结尾换行，原文已保留。");
  }

  return Object.freeze({format: "quill-delta", version: 1, ops: Object.freeze(ops)});
}

/** Serialize Quill's complete document snapshot without dropping unsupported formats. */
export function serializeRichDelta(ops: readonly RichDeltaOperation[]): string {
  const checked = validateOperations(ops);
  return JSON.stringify({format: "quill-delta", version: 1, ops: checked});
}

/** Extract visible text from a valid envelope; undefined means its stored format is unknown or damaged. */
export function extractRichDeltaText(content: string): string | undefined {
  try {
    const envelope = parseRichDeltaEnvelope(content);
    const text = envelope.ops.map(operation => operation.insert).join("");
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  } catch {
    return undefined;
  }
}

/** Return plain source text directly, or validated visible text for a rich-delta document. */
export function getRichEditorText(content: string, format: EditorFormat): string | undefined {
  if (format === "plain-text") return content;
  if (format === "rich-delta") return extractRichDeltaText(content);
  return undefined;
}

/** Create a lossless rich envelope from a plain source, preserving a source terminal newline. */
export function createRichDeltaFromPlainText(content: string): string {
  return serializeRichDelta([Object.freeze({insert: `${content}\n`})]);
}

function validateOperations(ops: readonly RichDeltaOperation[]): readonly RichDeltaOperation[] {
  if (!Array.isArray(ops) || !ops.length) throw new Error("富文本快照必须包含文档内容。");
  const checked: RichDeltaOperation[] = [];
  let text = "";
  for (const operation of ops) {
    if (!isRecord(operation) || !hasExactKeys(operation, ["insert", "attributes"], ["insert"])) {
      throw new Error("富文本快照只支持 insert 操作。");
    }
    if (typeof operation.insert !== "string" || operation.insert.length === 0) {
      throw new Error("富文本快照只支持非空文本插入操作。");
    }
    const attributes = parseAttributes(operation.attributes);
    text += operation.insert;
    checked.push(Object.freeze(attributes ? {insert: operation.insert, attributes} : {insert: operation.insert}));
  }
  if (!text.endsWith("\n")) throw new Error("富文本快照必须以 Quill 文档结尾换行结束。");
  return Object.freeze(checked);
}

function parseAttributes(value: unknown): RichDeltaAttributes | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("富文本快照包含无效格式属性。");
  const attributes: Record<string, boolean | number | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!supportedAttributes.has(key)) throw new Error(`富文本格式“${key}”尚不支持，原文已保留。`);
    if (key === "align") {
      if (item === "left") continue;
      if (item !== "center" && item !== "right" && item !== "justify") {
        throw new Error("富文本对齐方式无效，原文已保留。");
      }
      attributes[key] = item;
      continue;
    }
    if (key === "font") {
      if (!isRichFontFamily(item)) throw new Error("富文本字体名称无效，原文已保留。");
      attributes[key] = item;
      continue;
    }
    if (key === "size") {
      if (!isRichTextSize(item)) throw new Error("富文本字号无效，原文已保留。");
      attributes[key] = item;
      continue;
    }
    if (key === "color" || key === "background") {
      if (!isRichTextColor(item)) throw new Error(`富文本${key === "color" ? "文字颜色" : "背景色"}无效，原文已保留。`);
      attributes[key] = item;
      continue;
    }
    if (["bold", "italic", "underline", "strike", "blockquote"].includes(key)) {
      if (item !== true) throw new Error(`富文本格式“${key}”的值无效，原文已保留。`);
      attributes[key] = true;
      continue;
    }
    if (key === "header") {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 6) {
        throw new Error("富文本标题级别无效，原文已保留。");
      }
      attributes[key] = item;
      continue;
    }
    if (key === "list") {
      if (item !== "ordered" && item !== "bullet") throw new Error("富文本列表格式无效，原文已保留。");
      attributes[key] = item;
      continue;
    }
    if (key === "link") {
      if (typeof item !== "string" || !/^(https?:\/\/|mailto:|tel:|sms:)/i.test(item)) {
        throw new Error("富文本链接地址不受支持，原文已保留。");
      }
      attributes[key] = item;
    }
  }
  const blockAttributes = ["header", "list", "blockquote"].filter(key => key in attributes);
  if (blockAttributes.length > 1) throw new Error("富文本段落格式冲突，原文已保留。");
  return Object.keys(attributes).length ? Object.freeze(attributes) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed) {
  const keys = Object.keys(value);
  return required.every(key => key in value) && keys.every(key => allowed.includes(key));
}
