import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function loadFormat() {
  const fixture = createMainFixture({sameRealm: true});
  return fixture.loadModule("plugins/rich-text-editor/richDeltaFormat.ts");
}

test("rich Delta serialization preserves supported formatting and text extraction removes only the sentinel newline", () => {
  const {serializeRichDelta, parseRichDeltaEnvelope, extractRichDeltaText, getRichEditorText} = loadFormat();
  const operations = [
    {insert: "加粗", attributes: {bold: true}},
    {insert: " 与普通文字\n"},
  ];
  const serialized = serializeRichDelta(operations);
  const parsed = parseRichDeltaEnvelope(serialized);

  assert.deepEqual(parsed, {format: "quill-delta", version: 1, ops: operations});
  assert.equal(extractRichDeltaText(serialized), "加粗 与普通文字");
  assert.equal(getRichEditorText(serialized, "rich-delta"), "加粗 与普通文字");
});

test("plain-text conversion preserves user newlines and plain-text extraction never guesses from JSON", () => {
  const {createRichDeltaFromPlainText, getRichEditorText} = loadFormat();
  const text = "第一行\n第二行\n";
  const delta = createRichDeltaFromPlainText(text);

  assert.equal(getRichEditorText(delta, "rich-delta"), text,
    "the Quill sentinel is removed while a newline already present in the source is retained");
  assert.equal(getRichEditorText(delta, "plain-text"), delta,
    "TXT content stays literal even when it happens to contain a Delta envelope");
});

test("damaged or unsupported rich Delta content is rejected instead of rewritten as empty text", () => {
  const {parseRichDeltaEnvelope, extractRichDeltaText, getRichEditorText} = loadFormat();
  const unsupported = JSON.stringify({format: "quill-delta", version: 2, ops: [{insert: "text\n"}]});

  for (const content of ["{", unsupported]) {
    assert.throws(() => parseRichDeltaEnvelope(content));
    assert.equal(extractRichDeltaText(content), undefined);
    assert.equal(getRichEditorText(content, "rich-delta"), undefined);
  }
});

test("plain-text paste replaces the selected range with normalized line endings", () => {
  const fixture = createMainFixture({sameRealm: true});
  const {createPlainTextPasteDelta} = fixture.loadModule("plugins/rich-text-editor/plainTextPaste.ts");

  assert.deepEqual(createPlainTextPasteDelta({index: 2, length: 3}, "a\r\nb"), {
    ops: [{retain: 2}, {delete: 3}, {insert: "a\nb"}],
    cursorIndex: 5,
  });
  assert.equal(createPlainTextPasteDelta({index: 2, length: 3}, ""), undefined);
});

test("rich Delta round-trips alignment, system font names, size, foreground, and background", () => {
  const {serializeRichDelta, parseRichDeltaEnvelope} = loadFormat();
  const operations = [
    {insert: "居中", attributes: {font: "宋体", size: "18px", color: "#ABC", background: "rgb(255, 128, 0)"}},
    {insert: "\n", attributes: {align: "center"}},
    {insert: "右对齐", attributes: {font: "Noto Sans CJK SC", size: "12.5px", color: "#aabbcc", background: "#123"}},
    {insert: "\n", attributes: {align: "right"}},
    {insert: "两端对齐", attributes: {font: "O'Brien", size: "256px", color: "rgb(0, 128, 255)", background: "rgb(1, 2, 3)"}},
    {insert: "\n", attributes: {align: "justify"}},
    {insert: "引号和标点", attributes: {font: 'A"B, (Subset)', size: "1px"}},
    {insert: "\n"},
    {insert: "不存在于当前机器也保留", attributes: {font: "A Future System Font"}},
    {insert: "\n"},
    {insert: "最长允许的字体名", attributes: {font: "x".repeat(1024)}},
    {insert: "\n"},
  ];

  const roundTripped = parseRichDeltaEnvelope(serializeRichDelta(operations));
  assert.deepEqual(roundTripped.ops, operations);
});

test("left alignment is normalized away as the default paragraph format", () => {
  const {serializeRichDelta, parseRichDeltaEnvelope} = loadFormat();
  const source = JSON.stringify({
    format: "quill-delta",
    version: 1,
    ops: [{insert: "默认左对齐\n", attributes: {align: "left", bold: true}}],
  });

  assert.deepEqual(parseRichDeltaEnvelope(source).ops, [
    {insert: "默认左对齐\n", attributes: {bold: true}},
  ]);
  assert.deepEqual(parseRichDeltaEnvelope(serializeRichDelta([
    {insert: "默认左对齐\n", attributes: {align: "left"}},
  ])).ops, [{insert: "默认左对齐\n"}]);
});

test("rich Delta formatting rejects unsupported alignment, unsafe font values, and invalid CSS values", () => {
  const {serializeRichDelta, parseRichDeltaEnvelope, isRichTextSize, isRichTextColor} = loadFormat();
  const invalidAttributes = [
    {align: "leftwards"},
    {align: "start"},
    {font: "   "},
    {font: "x".repeat(1025)},
    {font: "Family\u0000Name"},
    {size: "0px"},
    {size: "256.01px"},
    {size: "18pt"},
    {size: "url(https://example.test)"},
    {color: "red"},
    {color: "#12"},
    {color: "rgba(0, 0, 0, 1)"},
    {color: "rgb(0, 0, 256)"},
    {background: "url(javascript:alert(1))"},
    {background: "rgb(1%, 2%, 3%)"},
  ];

  for (const attributes of invalidAttributes) {
    const content = JSON.stringify({
      format: "quill-delta",
      version: 1,
      ops: [{insert: "文本\n", attributes}],
    });
    assert.throws(() => parseRichDeltaEnvelope(content), `parse should reject ${JSON.stringify(attributes)}`);
    assert.throws(() => serializeRichDelta([{insert: "文本\n", attributes}]),
      `serialize should reject ${JSON.stringify(attributes)}`);
  }

  assert.equal(isRichTextSize("1px"), true);
  assert.equal(isRichTextSize("18.5px"), true);
  assert.equal(isRichTextSize("257px"), false);
  assert.equal(isRichTextColor("#AbC"), true);
  assert.equal(isRichTextColor("rgb(0, 128, 255)"), true);
  assert.equal(isRichTextColor("rgb(0, 128, 256)"), false);
});

test("rich Delta serialization rejects non-plain operation objects", () => {
  const {serializeRichDelta} = loadFormat();
  class Operation { insert = "文本\n"; }
  assert.throws(() => serializeRichDelta([new Operation()]), /只支持 insert 操作/);
});
