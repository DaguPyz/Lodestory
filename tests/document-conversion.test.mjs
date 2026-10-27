import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, deferred} from "./helpers/mainStartupFixture.mjs";

function createHarness({content = "\uFEFFA\r\nB", documentId = "txt-1", convert} = {}) {
  const fixture = createMainFixture();
  const {createDocumentConversionController} = fixture.loadModule("plugins/body-editor/documentConversion.ts");
  const events = [];
  const saveRequests = [];
  const state = {
    documentId,
    format: "plain-text",
    content,
    visible: true,
    active: true,
    readOnly: false,
    saveState: "saved",
    conversions: [{
      key: "rich:convert-to-rich-text",
      id: "convert-to-rich-text",
      label: "转换为富文本文档",
      from: "plain-text",
      extension: "lode",
      convert: convert ?? (value => `rich:${value}`),
    }],
    onSaveAs: async request => { saveRequests.push(request); },
  };
  const controller = createDocumentConversionController(() => state, status => events.push(status));
  return {state, controller, events, saveRequests};
}

function hostValue(value) { return JSON.parse(JSON.stringify(value)); }

test("conversion reads committed native input before creating the target content", async () => {
  const h = createHarness({content: "before composition"});
  h.state.handle = {focus() {}, flushContent() { return "最终候选词\r\n"; }};
  await h.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.deepEqual(hostValue(h.saveRequests), [{extension: "lode", content: "rich:最终候选词\r\n"}]);
  const failure = createHarness();
  failure.state.handle = {focus() {}, flushContent() { throw new Error("native input unavailable"); }};
  await failure.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.deepEqual(failure.saveRequests, []);
  assert.equal(failure.events.at(-1).error, "native input unavailable");
});

test("host conversion saves the latest source through onSaveAs and retains the original TXT", async () => {
  const h = createHarness();
  h.state.content = "\uFEFFrévisé\r\n正文";
  await h.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.deepEqual(hostValue(h.saveRequests), [{extension: "lode", content: "rich:\uFEFFrévisé\r\n正文"}]);
  assert.equal(h.state.content, "\uFEFFrévisé\r\n正文", "conversion never replaces the source document buffer");
  assert.deepEqual(hostValue(h.events), [
    {key: "rich:convert-to-rich-text", busy: true},
    {key: "rich:convert-to-rich-text", busy: false},
  ]);
});

test("conversion and save failures report errors while keeping source content available", async () => {
  const conversionFailure = createHarness({convert() { throw new Error("serialization failure"); }});
  await conversionFailure.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.deepEqual(conversionFailure.saveRequests, []);
  assert.equal(conversionFailure.state.content, "\uFEFFA\r\nB");
  assert.deepEqual(hostValue(conversionFailure.events.at(-1)), {
    key: "rich:convert-to-rich-text", busy: false, error: "serialization failure",
  });

  const saveFailure = createHarness();
  saveFailure.state.onSaveAs = async () => { throw new Error("save denied"); };
  await saveFailure.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.equal(saveFailure.state.content, "\uFEFFA\r\nB");
  assert.deepEqual(hostValue(saveFailure.events.at(-1)), {
    key: "rich:convert-to-rich-text", busy: false, error: "save denied",
  });
});

test("a pending conversion rejects repeats and ignores a stale document action", async () => {
  const gate = deferred();
  let conversionCalls = 0;
  const h = createHarness({convert(value) { conversionCalls++; return `rich:${value}`; }});
  h.state.onSaveAs = async request => {
    h.saveRequests.push(request);
    await gate.promise;
  };
  const first = h.controller.run("txt-1", "rich:convert-to-rich-text");
  await Promise.resolve();
  await h.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.equal(conversionCalls, 1);
  assert.equal(h.saveRequests.length, 1);
  assert.equal(h.controller.isLocked(), true);
  gate.resolve();
  await first;
  assert.equal(h.controller.isLocked(), false);

  h.state.documentId = "txt-2";
  const previousCount = h.events.length;
  await h.controller.run("txt-1", "rich:convert-to-rich-text");
  assert.equal(h.saveRequests.length, 1, "an action retained from a previous document cannot save");
  assert.equal(h.events.length, previousCount);
});

test("invalidating a conversion after document switch suppresses its late failure", async () => {
  let rejectGate;
  const gate = {promise: new Promise((_, reject) => { rejectGate = reject; })};
  const h = createHarness();
  h.state.onSaveAs = async () => await gate.promise;
  const pending = h.controller.run("txt-1", "rich:convert-to-rich-text");
  await Promise.resolve();
  h.state.documentId = "txt-2";
  h.controller.invalidate();
  rejectGate(new Error("old document save failed"));
  await pending;
  assert.equal(h.controller.isLocked(), false);
  assert.deepEqual(hostValue(h.events), [{key: "rich:convert-to-rich-text", busy: true}],
    "a stale completion does not overwrite the newly selected document's state");
});
