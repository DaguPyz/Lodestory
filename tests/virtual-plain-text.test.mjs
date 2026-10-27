import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("large plain-text routing accounts for long documents and CRLF/CR line counts", () => {
  const f = createMainFixture();
  const {needsVirtualPlainText} = f.loadModule("plugins/rich-text-editor/virtualPlainText.ts");
  assert.equal(needsVirtualPlainText("短正文\n第二行"), false);
  assert.equal(needsVirtualPlainText("字".repeat(256 * 1024)), true);
  for (const eol of ["\n", "\r\n", "\r"]) {
    assert.equal(needsVirtualPlainText(Array(4999).fill("行").join(eol)), false);
    assert.equal(needsVirtualPlainText(Array(5000).fill("行").join(eol)), true);
  }
});

test("a large editor closed during its lazy import never creates a detached editor", async () => {
  let creates = 0;
  const f = createMainFixture({moduleMocks: {
    "plugins/rich-text-editor/largePlainTextDriver.ts": {createLargePlainTextDriver() { creates++; }},
  }});
  const {createLazyPlainTextDriver} = f.loadModule("plugins/rich-text-editor/virtualPlainText.ts");
  const driver = createLazyPlainTextDriver({}, "原文");
  const starting = driver.create();
  await driver.destroy();
  await starting;
  assert.equal(creates, 0);
});

test("the lazy viewport driver delegates the existing session protocol and cleans partial initialization", async () => {
  const failure = new Error("viewport initialization failed");
  let destroyed = 0;
  const f = createMainFixture({moduleMocks: {
    "plugins/rich-text-editor/largePlainTextDriver.ts": {createLargePlainTextDriver() {
      return {listen() {}, async create() { throw failure; }, async destroy() { destroyed++; }};
    }},
  }});
  const {createLazyPlainTextDriver} = f.loadModule("plugins/rich-text-editor/virtualPlainText.ts");
  const driver = createLazyPlainTextDriver({}, "原文");
  await assert.rejects(driver.create(), error => error === failure);
  assert.equal(destroyed, 1);
});
