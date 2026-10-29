import assert from "node:assert/strict";
import test from "node:test";
import {markdownSearchText} from "../src/plugins/markdown-editor/markdownSearchText.ts";

test("Markdown search text preserves visible text while omitting syntax and link destinations", () => {
  const text = markdownSearchText("# 章节标题\n\n**故事**里有[云韵](https://example.com/secret)和 `古剑`。\n\n- 山谷\n- 海边\n\n```js\nconst x = 1\n```\n\n| 名称 | 地点 |\n| --- | --- |\n| 林舟 | 青云门 |");
  for (const expected of ["章节标题", "故事里有云韵和 古剑。", "山谷", "海边", "const x = 1", "林舟", "青云门"]) {
    assert.ok(text.includes(expected), `visible text should contain ${expected}`);
  }
  assert.equal(text.includes("https://example.com/secret"), false);
  assert.equal(text.includes("**"), false);
});

test("Markdown search text preserves line breaks and separates table cells", () => {
  assert.equal(markdownSearchText("第一行\n第二行\n\n| 左 | 右 |\n| --- | --- |\n| 表格词 | 其他 |"),
    "第一行\n第二行\n左\n右\n表格词\n其他");
});
