import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import {createServer} from "vite";

function browserPath() {
  return process.env.LODESTORY_CHROME_PATH ?? process.env.CHROME_EXECUTABLE_PATH
    ?? process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

function bounded(promise, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function waitFor(action, message, timeoutMs = 30000, diagnostics = () => "") {
  const until = Date.now() + timeoutMs;
  let error;
  while (Date.now() < until) {
    try {
      const value = await action();
      if (value) return value;
    } catch (cause) { error = cause; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const cause = error?.message ?? message;
  const details = diagnostics();
  throw new Error(details ? `${cause}\nBrowser diagnostics:\n${details}` : cause);
}

function send(socket, pending, method, params = {}, sessionId) {
  const id = pending.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.commands.delete(id);
      reject(new Error(`CDP command '${method}' timed out.`));
    }, 10000);
    pending.commands.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
}

test("self-built plain-text editor keeps a huge source editable with a bounded viewport", async t => {
  const configuredExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (configuredExecutable) throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    t.skip(`Chrome is not installed at ${executablePath}; browser-level plain text checks were not run.`);
    return;
  }

  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-plain-text-browser-"));
  let chrome;
  let socket;
  let server;
  let chromeOutput = "";
  try {
    chrome = spawn(executablePath, ["--headless=new", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-debugging-port=0", "--remote-allow-origins=*",
      `--user-data-dir=${profile}`, "about:blank"], {stdio: ["ignore", "ignore", "pipe"]});
    chrome.stderr.on("data", chunk => {
      if (chromeOutput.length < 8000) chromeOutput += chunk.toString();
    });
    let launchError;
    let chromeExit;
    chrome.on("error", error => { launchError = error; });
    chrome.once("exit", (code, signal) => { chromeExit = {code, signal}; });
    const activePortFile = path.join(profile, "DevToolsActivePort");
    const browserWs = await waitFor(async () => {
      if (launchError) throw launchError;
      if (chromeExit) {
        throw new Error(`Chrome exited before startup (code ${chromeExit.code}, signal ${chromeExit.signal})${chromeOutput ? `:\n${chromeOutput}` : "."}`);
      }
      const lines = (await readFile(activePortFile, "utf8")).trim().split("\n");
      return lines[0] && lines[1] ? `ws://127.0.0.1:${lines[0]}${lines[1]}` : null;
    }, "Chrome did not open its local debugging endpoint.");
    socket = new WebSocket(browserWs);
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, {once: true});
      socket.addEventListener("error", reject, {once: true});
    }), "CDP websocket connection");
    const pending = {nextId: 1, commands: new Map()};
    const pageErrors = [];
    const moduleFailures = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") {
          const details = message.params.exceptionDetails;
          const frame = details.stackTrace?.callFrames?.[0];
          pageErrors.push(`${details.text}: ${details.exception?.description ?? "unknown exception"}`
            + (frame ? ` at ${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : ""));
        } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
          const values = message.params.args.map(argument => argument.value ?? argument.description ?? "").filter(Boolean);
          pageErrors.push(`console.error: ${values.join(" ") || "(no details)"}`);
        } else if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
          const {response, type} = message.params;
          moduleFailures.push(`HTTP ${response.status} (${type}): ${response.url}`);
        } else if (message.method === "Network.loadingFailed" && message.params.type === "Script") {
          moduleFailures.push(`Script load failed (${message.params.errorText}): ${message.params.requestId}`);
        }
        return;
      }
      const command = pending.commands.get(message.id);
      if (!command) return;
      pending.commands.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });
    const browserDiagnostics = () => [
      pageErrors.length ? `Page errors:\n${pageErrors.slice(-12).join("\n")}` : "Page errors: none captured",
      moduleFailures.length ? `Module/network failures:\n${moduleFailures.slice(-12).join("\n")}` : "Module/network failures: none captured",
    ].join("\n");

    server = await createServer({
      configFile: false, root: process.cwd(), appType: "mpa", plugins: [react()],
      cacheDir: path.join(profile, "vite-cache"),
      server: {host: "127.0.0.1", port: 0, strictPort: true, hmr: false}, logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const target = await send(socket, pending, "Target.createTarget", {url: "about:blank"});
    const attachment = await send(socket, pending, "Target.attachToTarget", {targetId: target.targetId, flatten: true});
    const sessionId = attachment.sessionId;
    const cdp = (method, params = {}) => send(socket, pending, method, params, sessionId);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Network.enable");
    await cdp("Emulation.setDeviceMetricsOverride", {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/plain-text.html`});
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? "unknown browser exception"}`);
      return result.result.value;
    };
    const fixture = (method, ...args) => evaluate(`window.__plainTextFixture?.[${JSON.stringify(method)}]?.(...${JSON.stringify(args)})`);
    const key = async (type, keyName, code, virtualKey, modifiers = 0) => cdp("Input.dispatchKeyEvent", {
      type, key: keyName, code, windowsVirtualKeyCode: virtualKey, modifiers,
    });
    const shortcut = async (keyName, code, virtualKey, modifiers) => {
      await key("keyDown", keyName, code, virtualKey, modifiers);
      await key("keyUp", keyName, code, virtualKey, modifiers);
    };
    const mouse = (type, x, y, button = "none", buttons = 0) => cdp("Input.dispatchMouseEvent", {
      type, x, y, button, buttons, clickCount: type.endsWith("Pressed") ? 1 : 0,
    });
    const commandModifier = process.platform === "darwin" ? 4 : 2;

    await waitFor(() => evaluate("typeof window.__plainTextFixture?.snapshot === 'function'"),
      "The plain-text browser fixture API did not mount.", 30000, browserDiagnostics);
    await waitFor(() => fixture("snapshot").then(state => state?.handleAvailable && state.modelLength !== null),
      "The self-built plain text editor did not become ready.", 30000, browserDiagnostics);

    await t.test("loads the complete CRLF document while rendering only nearby lines", async () => {
      const state = await fixture("snapshot");
      t.diagnostic(`huge fixture editor-ready time: ${Math.round(state.readyMs)} ms`);
      assert.equal(state.changeCount, 0, "initialization does not report edits");
      assert.equal(state.modelMatchesHost, true, "the driver retains the complete exact source");
      assert.ok(state.hostLength >= 6_700_000, `fixture has novel-scale text (${state.hostLength} UTF-16 code units)`);
      assert.equal(state.hasBom, true, "the UTF-8 BOM character is preserved");
      assert.equal(state.hasCRLF, true, "original CRLF separators are preserved");
      assert.equal(state.hasLoneLF, false, "loading does not normalize line endings");
      assert.equal(state.hasTerminalBlankLines, true, "both terminal blank lines are preserved");
      assert.ok(state.lineCount >= 198_037, `the full line index is present (${state.lineCount})`);
      assert.ok(state.renderedLines < 500, `only a bounded viewport is in the DOM (${state.renderedLines})`);
      assert.equal(state.debugRenderedLines, state.renderedLines, "the driver reports the DOM-backed viewport size");
      assert.equal(state.sameDriver, true, "the fixture is observing the mounted driver");
    });

    await t.test("keyboard and paste edits preserve host echo, line endings, undo and redo", async () => {
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "typed-"});
      await waitFor(() => fixture("snapshot").then(state => state.changeCount === 1), "Typed text did not reach onChange.");
      let state = await fixture("snapshot");
      assert.equal(state.hostMatchesLastChange, true);
      assert.equal(state.modelMatchesHost, true);
      assert.ok(state.sameDriver, "the parent content echo keeps the same editor instance");

      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("snapshot").then(value => value.changeCount === 2), "Undo did not report the restored source.");
      state = await fixture("snapshot");
      assert.ok(state.hostMatchesLastChange, "the host receives the complete undo result");
      assert.ok(state.modelMatchesHost, "undo and host state agree");

      await shortcut("z", "KeyZ", 90, commandModifier | 8);
      await waitFor(() => fixture("snapshot").then(value => value.changeCount === 3), "Redo did not report the typed source.");
      assert.ok((await fixture("snapshot")).modelMatchesHost, "redo and host state agree");

      await fixture("pasteAt", 1, "paste-A\r\npaste-B");
      await waitFor(() => fixture("snapshot").then(value => value.changeCount === 4), "Clipboard paste did not update the document.");
      state = await fixture("snapshot");
      assert.ok(state.modelMatchesHost, "paste reports the complete current source");
      assert.ok(state.hasCRLF && !state.hasLoneLF, "new pasted line endings use the document's CRLF separator");
      assert.ok(state.sameDriver, "editing does not rebuild the editor");
    });

    await t.test("measures fifty adjacent edits and observed frame gaps in the large document", async () => {
      assert.equal(await fixture("find", "line-000030-"), true);
      const found = await fixture("snapshot");
      await fixture("focusAt", found.selection.anchor);
      await fixture("resetFrameStats");
      await new Promise(resolve => setTimeout(resolve, 80));
      await fixture("resetFrameStats");
      const before = await fixture("snapshot");
      await fixture("startEditTiming");
      for (let index = 0; index < 50; index++) await cdp("Input.insertText", {text: "z"});
      await waitFor(() => fixture("snapshot").then(state => state.changeCount === before.changeCount + 50),
        "The editor did not report all 50 small changes.");
      const timing = await fixture("editTiming");
      const frames = await fixture("frameStats");
      t.diagnostic(`50 single-character edits: ${timing.elapsedMs.toFixed(1)} ms total; `
        + `first callback ${timing.firstEditMs?.toFixed(1)} ms, last ${timing.lastEditMs?.toFixed(1)} ms; `
        + `observed max RAF gap ${frames.maxGapMs.toFixed(1)} ms over ${frames.samples} frame intervals`);
      assert.equal(timing.changes, 50, "all 50 native-input transactions reached the owner");
      const after = await fixture("snapshot");
      assert.ok(after.modelMatchesHost && after.sameDriver, "rapid edits keep full model, host echo and mounted editor aligned");
    });

    await t.test("the native input path accepts committed Chinese IME text", async () => {
      await fixture("focusAt", 1);
      await cdp("Input.imeSetComposition", {text: "拼音候选", selectionStart: 4, selectionEnd: 4});
      await cdp("Input.insertText", {text: "中文提交"});
      await waitFor(() => fixture("hasText", "中文提交"), "The committed Chinese text did not reach the full document model.");
      const state = await fixture("snapshot");
      assert.ok(state.changeCount >= 5);
      assert.ok(state.modelMatchesHost && state.hostMatchesLastChange, "IME commit reaches the persistent-content callback");
      assert.ok(state.sameDriver, "IME input preserves the mounted editor");
    });

    await t.test("Cmd/Ctrl+S flushes a pending IME composition as one undoable edit", async () => {
      await fixture("checkpoint", "before-save-composition");
      await fixture("focusAt", 1);
      await cdp("Input.imeSetComposition", {text: "保存前候选", selectionStart: 5, selectionEnd: 5});
      await waitFor(() => fixture("hasText", "保存前候选"), "The pending composition did not reach the source model.");
      await shortcut("s", "KeyS", 83, commandModifier);
      await waitFor(() => fixture("snapshot").then(state => state.modelMatchesHost && state.hostMatchesLastChange),
        "Cmd/Ctrl+S did not flush the pending source value.");
      assert.equal(await fixture("hasText", "保存前候选"), true, "save-key handling retains the pending composition text");
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("matchesCheckpoint", "before-save-composition"),
        "One Undo did not restore the exact source before the composition.");
      assert.equal(await fixture("hasText", "保存前候选"), false, "the whole composition is a single undo operation");
    });

    await t.test("clicking outside commits a pending composition before leaving the editor", async () => {
      await fixture("checkpoint", "before-outside-composition");
      await fixture("focusAt", 1);
      await cdp("Input.imeSetComposition", {text: "点击外提交", selectionStart: 5, selectionEnd: 5});
      await waitFor(() => fixture("hasText", "点击外提交"), "The pending click-away composition did not reach the source model.");
      await mouse("mousePressed", 1200, 800, "left", 1);
      await mouse("mouseReleased", 1200, 800, "left", 0);
      const committed = await fixture("snapshot");
      assert.ok(committed.modelMatchesHost && committed.hostMatchesLastChange,
        "pointer-down outside the editor flushes the complete source to its owner");
      assert.equal(await fixture("hasText", "点击外提交"), true, "click-away preserves the composed text");
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("matchesCheckpoint", "before-outside-composition"),
        "Undo did not restore the source before click-away composition.");
    });

    await t.test("locking commits prior composition, rejects later input, and keeps undo available after unlock", async () => {
      await fixture("checkpoint", "before-readonly-composition");
      await fixture("focusAt", 1);
      await cdp("Input.imeSetComposition", {text: "锁定前候选", selectionStart: 5, selectionEnd: 5});
      await waitFor(() => fixture("hasText", "锁定前候选"), "The pending read-only composition did not reach the source model.");
      await fixture("setProps", {readOnly: true});
      await waitFor(() => fixture("snapshot").then(state => state.readOnly === true && state.modelMatchesHost),
        "Switching to read-only did not flush the composition.");
      assert.equal(await fixture("hasText", "锁定前候选"), true, "locking does not discard text entered before it");
      await fixture("checkpoint", "locked-content");
      const locked = await fixture("snapshot");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "锁定后禁止输入"});
      const rejected = await fixture("snapshot");
      assert.equal(rejected.changeCount, locked.changeCount, "read-only mode reports no new edits");
      assert.ok(await fixture("matchesCheckpoint", "locked-content"), "read-only mode leaves committed text unchanged");
      await fixture("setProps", {readOnly: false});
      await waitFor(() => fixture("snapshot").then(state => state.readOnly === false), "Unlock did not restore editability.");
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("matchesCheckpoint", "before-readonly-composition"),
        "After unlocking, one Undo removes the composition as one action.");
      assert.equal(await fixture("hasText", "锁定前候选"), false);
    });

    await t.test("copy and cut work for a selection spanning virtualized lines", async () => {
      assert.equal(await fixture("find", "line-001000-"), true, "find locates the first range");
      const first = await fixture("snapshot");
      const from = first.selection.anchor;
      assert.equal(await fixture("find", "line-001200-"), true, "find locates a distant range");
      const second = await fixture("snapshot");
      const to = second.selection.anchor;
      assert.ok(to > from + 1000, "the selected text crosses many virtual lines");
      const copy = await fixture("clipboardAt", "copy", from, to);
      assert.equal(copy.defaultPrevented, true, "the editor handles copy from the source model");
      assert.equal(copy.clipboardMatchesSelection, true, "clipboard text is the exact complete-model selection");
      assert.equal(copy.copiedLength, to - from);
      await fixture("setSelection", to, from);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: to, head: from},
        "a backwards selection retains its anchor and head across the large document");
      const reverseCopy = await fixture("clipboardCurrent", "copy");
      assert.equal(reverseCopy.clipboardMatchesSelection, true, "the reverse selection copies the exact same source interval");

      assert.equal(await fixture("find", "UNIQUE_TARGET_TOKEN"), true);
      const target = await fixture("snapshot");
      const cut = await fixture("clipboardAt", "cut", target.selection.head, target.selection.anchor);
      assert.equal(cut.clipboardMatchesSelection, true, "cut copies the complete selected text");
      assert.equal(await fixture("hasText", "UNIQUE_TARGET_TOKEN"), false, "cut removes the selected text");
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("hasText", "UNIQUE_TARGET_TOKEN"), "Undo did not restore text after cut.");
    });

    await t.test("find and replace operate against the complete source", async () => {
      assert.equal(await fixture("find", "UNIQUE_TARGET_TOKEN"), true, "search sees distant source text");
      const selected = await fixture("snapshot");
      assert.equal(selected.selection.head - selected.selection.anchor, "UNIQUE_TARGET_TOKEN".length);
      await fixture("replaceSelection", "REPLACED_TARGET_TOKEN");
      await waitFor(() => fixture("hasText", "REPLACED_TARGET_TOKEN"), "Replace did not update the full model.");
      assert.equal(await fixture("hasText", "UNIQUE_TARGET_TOKEN"), false);
      assert.ok((await fixture("snapshot")).modelMatchesHost, "replace emits the full updated source");
    });

    await t.test("pointer clicks place the caret, and drag selection auto-scrolls across virtual rows", async () => {
      assert.equal(await fixture("find", "line-000020-"), true);
      const found = await fixture("snapshot");
      const clickOffset = found.selection.anchor + 5;
      const point = await fixture("pointAt", clickOffset);
      await mouse("mousePressed", point.x, point.y, "left", 1);
      await mouse("mouseReleased", point.x, point.y, "left", 0);
      let state = await fixture("snapshot");
      assert.ok(Math.abs(state.selection.head - clickOffset) <= 1,
        `a screen click places the caret near the clicked character (${state.selection.head} vs ${clickOffset})`);

      const startOffset = (await fixture("find", "line-000015-") && (await fixture("snapshot")).selection.anchor) + 5;
      const startPoint = await fixture("pointAt", startOffset);
      const initialViewport = await fixture("viewportState");
      await mouse("mousePressed", startPoint.x, startPoint.y, "left", 1);
      await mouse("mouseMoved", startPoint.x + 10, initialViewport.bottom + 40, "left", 1);
      await waitFor(() => fixture("viewportState").then(value => value.scrollTop > initialViewport.scrollTop + 100),
        "Dragging past the viewport edge did not auto-scroll.", 5000);
      state = await fixture("snapshot");
      assert.equal(state.selection.anchor, startOffset, "drag keeps its original anchor");
      assert.ok(state.selection.head > startOffset + 100, "the drag endpoint advances with the scrolling viewport");
      await mouse("mouseReleased", startPoint.x + 10, initialViewport.bottom + 40, "left", 0);
      const copy = await fixture("clipboardCurrent", "copy");
      assert.equal(copy.defaultPrevented, true);
      assert.equal(copy.clipboardMatchesSelection, true, "the drag selection copies exact source text across virtual rows");
    });

    await t.test("Home, End, arrows, word moves and select-all preserve selection direction", async () => {
      const sample = "one two\r\nalpha beta\r\n";
      await fixture("setProps", {content: sample});
      await waitFor(() => fixture("snapshot").then(state => state.modelMatchesHost && state.modelLength === sample.length),
        "The cursor-movement sample did not load.");

      await fixture("focusAt", 7);
      await shortcut("Home", "Home", 36, 0);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 0, head: 0}, "Home moves to the logical line start");
      await fixture("focusAt", 2);
      await shortcut("End", "End", 35, 0);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 7, head: 7}, "End moves before the line ending");

      await fixture("focusAt", 4);
      await shortcut("ArrowRight", "ArrowRight", 39, 0);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 5, head: 5}, "Right advances one text boundary");
      await shortcut("ArrowRight", "ArrowRight", 39, 8);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 5, head: 6}, "Shift+Right extends from the existing anchor");

      await fixture("focusAt", 13);
      await shortcut("ArrowUp", "ArrowUp", 38, 0);
      let state = await fixture("snapshot");
      assert.equal(state.selectionLine, 0, "Up moves to the previous logical line");
      assert.ok(state.selection.head < 8, "the caret stays on the closest visual column in the previous line");
      await shortcut("ArrowDown", "ArrowDown", 40, 0);
      state = await fixture("snapshot");
      assert.deepEqual(state.selection, {anchor: 13, head: 13}, "Down restores the original visual column");
      assert.equal(state.selectionLine, 1);

      const wordModifier = process.platform === "darwin" ? 1 : 2;
      await fixture("focusAt", 0);
      await shortcut("ArrowRight", "ArrowRight", 39, wordModifier);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 4, head: 4}, "Alt/Ctrl+Right advances to the next word");
      await shortcut("ArrowLeft", "ArrowLeft", 37, wordModifier);
      assert.deepEqual((await fixture("snapshot")).selection, {anchor: 0, head: 0}, "Alt/Ctrl+Left returns to the word start");

      await shortcut("a", "KeyA", 65, commandModifier);
      const all = await fixture("snapshot");
      assert.deepEqual(all.selection, {anchor: 0, head: sample.length}, "Cmd/Ctrl+A selects the entire document");
      const wholeCopy = await fixture("clipboardCurrent", "copy");
      assert.equal(wholeCopy.clipboardMatchesSelection, true, "select-all copy includes the exact full source");
      await fixture("setSelection", sample.length - 2, 1);
      const reverse = await fixture("snapshot");
      assert.deepEqual(reverse.selection, {anchor: sample.length - 2, head: 1}, "backward selections retain their direction");
      assert.equal((await fixture("clipboardCurrent", "copy")).clipboardMatchesSelection, true,
        "reverse selection copies the same complete interval");

      await fixture("setProps", {content: "\uFEFFx"});
      await fixture("focusAt", 0);
      const beforeShiftTab = await fixture("snapshot");
      await shortcut("Tab", "Tab", 9, 8);
      const afterShiftTab = await fixture("snapshot");
      assert.equal(afterShiftTab.modelLength, beforeShiftTab.modelLength, "Shift-Tab at offset zero is a no-op");
      assert.equal(afterShiftTab.errorText, null, "Shift-Tab at the start does not report a range error");
    });

    await t.test("find panel flags, replace-all, mixed EOLs and undo preserve untouched separators", async () => {
      const mixed = "hit\r\nhitword\nHit\rhit\r\ntag-10 tag-20 tag-30x\r\n";
      await fixture("setProps", {content: mixed});
      await waitFor(() => fixture("snapshot").then(state => state.modelLength === mixed.length && state.modelMatchesHost),
        "The mixed-EOL search sample did not load.");
      const originalBreaks = await fixture("lineBreakCounts");
      await fixture("focusAt", 0);
      await shortcut("f", "KeyF", 70, commandModifier);
      await waitFor(() => evaluate(`Boolean(document.querySelector('.plain-text-search:not([hidden])'))`),
        "Cmd/Ctrl+F did not open the find panel.");
      await fixture("setSearch", "hit", "MATCH", {caseSensitive: true, wholeWord: true});
      await fixture("clickSearch", "全部替换");
      await waitFor(() => fixture("hasText", "MATCH"), "Whole-word Replace All did not edit the document.");
      assert.equal(await fixture("countText", "MATCH"), 2, "case-sensitive whole-word replacement changes only the two lowercase standalone matches");
      assert.equal(await fixture("hasText", "hitword"), true, "whole-word mode leaves longer tokens intact");
      assert.equal(await fixture("hasText", "Hit"), true, "case-sensitive mode leaves different capitalization intact");
      assert.deepEqual(await fixture("lineBreakCounts"), originalBreaks, "replace-all preserves every original CRLF, LF and CR separator");
      await fixture("focusAt", 0);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("exactSlice", 0, mixed.length, mixed), "Undo did not restore the exact mixed-EOL source.");

      await fixture("setSearch", "tag-(\\d+)(?!\\w)", "part-$1", {regexp: true});
      await fixture("clickSearch", "全部替换");
      await waitFor(() => fixture("hasText", "part-10"), "Regex Replace All did not edit numeric matches.");
      assert.equal(await fixture("countText", "part-10"), 1);
      assert.equal(await fixture("countText", "part-20"), 1);
      assert.ok(await fixture("hasText", "tag-30x"), "regex replacement does not alter unmatched suffixes");
      assert.deepEqual(await fixture("lineBreakCounts"), originalBreaks, "regex replacement retains mixed original line endings");
      await fixture("focusAt", 0);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("exactSlice", 0, mixed.length, mixed), "Undo did not reverse the regex replace-all operation.");
    });

    await t.test("one 220k-character line virtualizes, and backspace keeps Unicode graphemes whole", async () => {
      const clusters = ["👩‍👩‍👧‍👦", "e\u0301", "🇨🇳", "👍🏽"];
      const prefix = "\uFEFF" + "a".repeat(220_000);
      const line = prefix + clusters.join("") + "z";
      await fixture("setProps", {content: line});
      await waitFor(() => fixture("snapshot").then(state => state.modelLength === line.length && state.modelMatchesHost),
        "The long single line did not load in full.", 30000);
      let state = await fixture("snapshot");
      assert.equal(state.lineCount, 1, "the fixture contains one logical line without a final newline");
      assert.ok(state.renderedLines < 500, `only wrapped rows near the viewport are mounted (${state.renderedLines})`);

      let end = prefix.length;
      for (const cluster of clusters) {
        end += cluster.length;
        const beforeLength = (await fixture("snapshot")).modelLength;
        await fixture("focusAt", end);
        await shortcut("Backspace", "Backspace", 8, 0);
        await waitFor(() => fixture("snapshot").then(value => value.modelLength === beforeLength - cluster.length),
          `Backspace did not remove the whole grapheme ${cluster}.`);
        assert.equal(await fixture("hasText", cluster), false, `Backspace removed all code units in ${cluster}`);
        await shortcut("z", "KeyZ", 90, commandModifier);
        await waitFor(() => fixture("snapshot").then(value => value.modelLength === beforeLength),
          `Undo did not restore the full grapheme ${cluster}.`);
        assert.equal(await fixture("hasText", cluster), true, `undo restored ${cluster} exactly`);
      }
      state = await fixture("snapshot");
      assert.equal(state.modelMatchesHost, true, "Unicode edits continue to report the exact long-line source");
    });

    await t.test("read-only, inactive, external replacement and undo history stay isolated", async () => {
      const before = await fixture("snapshot");
      await fixture("setProps", {readOnly: true});
      await waitFor(() => fixture("snapshot").then(state => state.readOnly === true), "Read-only mode did not activate.");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "blocked"});
      assert.equal((await fixture("snapshot")).hostLength, before.hostLength, "read-only mode accepts no input");

      await fixture("setProps", {readOnly: false, active: false});
      await waitFor(() => fixture("snapshot").then(state => state.readOnly === true), "Inactive mode did not lock the input.");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "blocked"});
      assert.equal((await fixture("snapshot")).hostLength, before.hostLength, "inactive documents accept no input");

      const replacement = "\uFEFFreplacement\r\n\r\n";
      await fixture("setProps", {content: replacement, active: true});
      await waitFor(() => fixture("snapshot").then(state => state.modelLength === replacement.length && state.modelMatchesHost),
        "External content did not replace the large model.");
      const beforeUndo = await fixture("snapshot");
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterUndo = await fixture("snapshot");
      assert.equal(afterUndo.modelLength, beforeUndo.modelLength, "undo cannot restore stale text from before replacement");
      assert.equal(afterUndo.changeCount, beforeUndo.changeCount, "external replacement is not a user edit");
      assert.equal(afterUndo.modelMatchesHost, true);
    });

    await t.test("flush accepts an external snapshot before React renders and preserves pending native input", async () => {
      const external = "外部替换\r\n新行\r\n";
      const before = await fixture("snapshot");
      await fixture("setPropsWithoutRender", {content: external});
      const externallyFlushed = await fixture("flushContent", external);
      assert.equal(externallyFlushed, external, "the new host snapshot replaces an older model before React renders");
      let state = await fixture("snapshot");
      assert.equal(state.modelMatchesHost, true, "the editor model and host snapshot agree after early acceptance");
      assert.equal(state.changeCount, before.changeCount, "external replacement is not reported as a user edit");

      await fixture("renderProps");
      await waitFor(() => fixture("snapshot").then(value => value.modelMatchesHost),
        "Rendering the already accepted external snapshot replaced or diverged from the model.");
      await fixture("focusAt", 2);
      await fixture("stageNativeInput", "候选输入");
      const expected = "外部候选输入替换\r\n新行\r\n";
      const flushedPending = await fixture("flushContent", external);
      assert.equal(flushedPending, expected, "the accepted old host value does not overwrite newer unreported native input");
      state = await fixture("snapshot");
      assert.equal(state.modelMatchesHost, true, "pending native input is synchronously reported to the host");
      assert.ok(state.changeCount > before.changeCount, "flushing pending native input emits an edit callback");
    });

    await t.test("native LF insertion into CRLF text leaves the caret after the complete separator", async () => {
      const source = "x\r\nB";
      await fixture("setProps", {content: source});
      await waitFor(() => fixture("snapshot").then(state => state.modelMatchesHost && state.modelLength === source.length),
        "The native-newline sample did not load.");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "\n"});
      const afterNewline = "x\r\n\r\nB";
      await waitFor(() => fixture("exactSlice", 0, afterNewline.length, afterNewline),
        "Native LF input was not normalized to the source CRLF separator.");
      let state = await fixture("snapshot");
      assert.equal(state.selection.head, 3, "the caret maps to after the inserted CRLF, not between CR and LF");

      await cdp("Input.insertText", {text: "z"});
      const afterNextKey = "x\r\nz\r\nB";
      await waitFor(() => fixture("exactSlice", 0, afterNextKey.length, afterNextKey),
        "Typing after the native newline split or displaced the CRLF separator.");
      state = await fixture("snapshot");
      assert.equal(state.selection.head, 4, "the next character is inserted at the caret after the newline");
      assert.deepEqual(await fixture("lineBreakCounts"), {crlf: 2, lf: 0, cr: 0},
        "native newline and subsequent input retain complete CRLF pairs");
    });

    await t.test("Enter, Tab, Shift-Tab and Backspace keep plain-text behavior", async () => {
      const sample = "\uFEFF  正文\r\n尾行\r\n";
      await fixture("setProps", {content: sample});
      await waitFor(() => fixture("snapshot").then(state => state.modelLength === sample.length && state.modelMatchesHost),
        "The short keyboard sample did not load.");
      await fixture("focusAt", 7);
      await shortcut("Enter", "Enter", 13, 0);
      const entered = "\uFEFF  正文\r\n\r\n尾行\r\n";
      await waitFor(() => fixture("exactSlice", 0, entered.length, entered), "Enter did not insert the document newline.");
      await shortcut("Tab", "Tab", 9, 0);
      const tabbed = "\uFEFF  正文\r\n\r\n\t尾行\r\n";
      assert.equal(await fixture("exactSlice", 0, tabbed.length, tabbed), true, "Tab inserts a literal tab");
      await shortcut("Tab", "Tab", 9, 8);
      await waitFor(() => fixture("exactSlice", 0, entered.length, entered), "Shift-Tab removes the preceding literal tab.");
      await fixture("focusAt", 5);
      await shortcut("Backspace", "Backspace", 8, 0);
      const backspaced = "\uFEFF  正\r\n";
      assert.equal(await fixture("exactSlice", 0, backspaced.length, backspaced), true, "Backspace deletes one character without indentation rules");
    });

    await t.test("initialization failures clear a detached root and remove document listeners", async () => {
      for (const kind of ["canvas", "resize-observer"]) {
        const state = await fixture("testDriverInitFailure", kind);
        assert.equal(state.threw, true, `${kind} failure is surfaced to the caller`);
        assert.equal(state.rootChildren, 0, `${kind} failure clears its temporary root`);
        assert.equal(state.driverRegistered, false, `${kind} failure does not register a partial driver`);
        assert.equal(state.temporaryRootsRemaining, 0, `${kind} failure removes its detached root from the document`);
        assert.equal(state.documentListenersAdded, state.documentListenersRemoved,
          `${kind} failure removes every document-level handler installed during initialization`);
        if (kind === "canvas") assert.match(state.message, /排版上下文/);
        else assert.match(state.message, /ResizeObserver construction failure/);
      }
    });

    await t.test("worker completion follows committed input and accepts as one undoable edit", async () => {
      const sample = "她在名册上找到了";
      await fixture("setProps", {content: sample});
      await fixture("setCompletionAssets", ["林月", "林川", "林月见", "林湾"]);
      await waitFor(() => evaluate("document.querySelector('textarea.plain-text-input')?.getAttribute('aria-autocomplete') === 'list'"),
        "The registered completion source did not reach the editor.");
      await fixture("focusAt", sample.length);
      const list = () => evaluate(`[...document.querySelectorAll('.plain-text-completion:not([hidden]) .plain-text-completion-name')].map(node => node.textContent)`);
      await cdp("Input.imeSetComposition", {text: "林", selectionStart: 1, selectionEnd: 1});
      assert.deepEqual(await list(), [], "the popup stays closed while the applied IME text is provisional");
      await cdp("Input.insertText", {text: "林"});
      const names = await waitFor(() => list().then(values => values.length && values), "The first Chinese character did not trigger worker completion.");
      assert.deepEqual(names, ["林川", "林月", "林月见", "林湾"]);
      await cdp("Input.insertText", {text: "月"});
      await waitFor(() => list().then(values => values.length === 1 && values[0] === "林月见"),
        "The displayed candidates did not follow the new prefix.");
      await shortcut("ArrowDown", "ArrowDown", 40, 0);
      assert.equal(await evaluate("document.querySelector('textarea.plain-text-input') === document.activeElement"), true);
      await shortcut("Enter", "Enter", 13, 0);
      assert.equal(await fixture("exactSlice", 0, sample.length + 3, sample + "林月见"), true);
      assert.equal((await fixture("snapshot")).modelLength, sample.length + 3);
      await shortcut("z", "KeyZ", 90, commandModifier);
      assert.equal(await fixture("exactSlice", 0, sample.length + 2, sample + "林月"), true);
      assert.equal((await fixture("snapshot")).modelLength, sample.length + 2);

      await fixture("setCompletionAssets", ["林舟"]);
      await fixture("setProps", {content: sample});
      await waitFor(() => fixture("snapshot").then(state => state.modelLength === sample.length), "The completion sample did not reset.");
      await fixture("focusAt", sample.length);
      await cdp("Input.insertText", {text: "林"});
      await waitFor(() => list().then(values => values.length === 1 && values[0] === "林舟"), "The new asset snapshot did not replace the worker index.");
      await shortcut("Enter", "Enter", 13, 0);
      assert.equal(await fixture("exactSlice", 0, sample.length + 2, sample + "林\n"), true, "Enter inserts a newline before a candidate is selected");
      await fixture("focusAt", sample.length + 1);
      await fixture("openCompletion");
      await waitFor(() => list().then(values => values[0] === "林舟"), "The manual completion action did not reopen the list.");
      await fixture("removeCompletion");
      assert.deepEqual(await list(), []);
      assert.equal(await evaluate("document.querySelector('textarea.plain-text-input').hasAttribute('aria-autocomplete')"), false);
    });

    await t.test("deleting back to a matching prefix reopens a settled empty completion list", async () => {
      const start = "仪式名为";
      const word = start + "焚烧";
      const prefix = start + "焚";
      const candidates = () => evaluate(`[...document.querySelectorAll('.plain-text-completion:not([hidden]) .plain-text-completion-name')].map(node => node.textContent)`);
      await fixture("setProps", {content: start});
      await fixture("setCompletionAssets", ["焚烧"]);
      await waitFor(() => evaluate("document.querySelector('textarea.plain-text-input').getAttribute('aria-autocomplete') === 'list'"),
        "The completion source did not reach the editor.");
      await fixture("focusAt", start.length);
      await cdp("Input.insertText", {text: "焚"});
      await waitFor(() => candidates().then(names => names[0] === "焚烧"), "Typing the prefix did not show the candidate.");
      await cdp("Input.insertText", {text: "烧"});
      await fixture("completionSettled");
      assert.deepEqual(await candidates(), [], "the complete word has no candidates");
      assert.equal(await fixture("exactSlice", 0, word.length, word), true);

      await shortcut("Backspace", "Backspace", 8, 0);
      await waitFor(() => candidates().then(names => names[0] === "焚烧"), "Backspace did not restore the candidate.");
      assert.equal(await fixture("exactSlice", 0, prefix.length, prefix), true);

      await cdp("Input.insertText", {text: "烧"});
      await fixture("completionSettled");
      await fixture("focusAt", prefix.length);
      await shortcut("Delete", "Delete", 46, 0);
      await waitFor(() => candidates().then(names => names[0] === "焚烧"), "Forward delete did not restore the candidate.");

      await cdp("Input.insertText", {text: "烧"});
      await fixture("completionSettled");
      await evaluate(`document.querySelector('textarea.plain-text-input').dispatchEvent(new InputEvent('beforeinput',
        {inputType: 'deleteContentBackward', bubbles: true, cancelable: true}))`);
      await waitFor(() => candidates().then(names => names[0] === "焚烧"), "Native backward deletion did not restore the candidate.");
      await fixture("removeCompletion");
    });

    await t.test("completion shows ten rows and scrolls to candidates beyond the first screen", async () => {
      const names = Array.from({length: 41}, (_, index) => "林" + String(index).padStart(2, "0"));
      await fixture("setProps", {content: ""});
      await fixture("setCompletionAssets", names);
      await waitFor(() => evaluate("document.querySelector('textarea.plain-text-input').getAttribute('aria-autocomplete') === 'list'"),
        "The completion source did not reach the editor.");
      await fixture("focusAt", 0);
      await cdp("Input.insertText", {text: "林"});
      const metrics = () => evaluate(`(() => {
        const scroll = document.querySelector('.plain-text-completion:not([hidden]) .plain-text-completion-scroll');
        if (!scroll) return null;
        const rows = [...scroll.querySelectorAll('[role=option]')];
        const active = document.querySelector('.plain-text-input').getAttribute('aria-activedescendant');
        const rect = scroll.getBoundingClientRect();
        return {visibleRows: scroll.clientHeight / rows[0].getBoundingClientRect().height,
          listSize: Number(rows[0].getAttribute('aria-setsize')), renderedRows: rows.length, scrollTop: scroll.scrollTop,
          activeIndex: Number(document.getElementById(active)?.dataset.index),
          x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      const initial = await waitFor(metrics, "The scrolling completion list did not open.");
      assert.equal(initial.visibleRows, 10);
      assert.equal(initial.listSize, names.length);
      assert.ok(initial.renderedRows < names.length);

      for (let index = 0; index < 11; index++) await shortcut("ArrowDown", "ArrowDown", 40, 0);
      const selected = await metrics();
      assert.equal(selected.activeIndex, 10);
      assert.ok(selected.scrollTop > 0, "keyboard selection scrolls to the eleventh option");

      await cdp("Input.dispatchMouseEvent", {type: "mouseWheel", x: initial.x, y: initial.y, deltaY: 1500, deltaX: 0});
      const last = await waitFor(() => evaluate(`(() => {
        const row = document.querySelector('.plain-text-completion-option[data-index="${names.length - 1}"]');
        if (!row) return null;
        const bounds = row.getBoundingClientRect();
        const clip = row.closest('.plain-text-completion-scroll').getBoundingClientRect();
        return bounds.bottom <= clip.bottom ? {x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2} : null;
      })()`), "Scrolling did not reach the final candidate.");
      await mouse("mousePressed", last.x, last.y, "left", 1);
      await mouse("mouseReleased", last.x, last.y, "left", 0);
      assert.equal(await fixture("flushContent"), names.at(-1));
      await fixture("removeCompletion");
    });

    await t.test("unmount releases the handle, input and rendered line nodes", async () => {
      await fixture("unmount");
      await waitFor(() => evaluate(`document.querySelectorAll('.plain-text-editor').length === 0`),
        "Unmount did not clear the editor element.");
      const state = await fixture("snapshot");
      assert.equal(state.handleAvailable, false, "the host handle clears during unmount");
      assert.equal(state.renderedLines, 0, "virtual line nodes are removed during unmount");
    });

    assert.deepEqual(pageErrors, [], "the browser reports no editor exceptions");
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      await bounded(new Promise(resolve => chrome.once("exit", resolve)), "Chrome shutdown").catch(() => {});
    }
    if (server) await bounded(server.close(), "Vite server shutdown").catch(() => {});
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
