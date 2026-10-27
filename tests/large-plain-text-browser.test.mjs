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

async function waitFor(action, message, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let error;
  while (Date.now() < until) {
    try {
      const value = await action();
      if (value) return value;
    } catch (cause) { error = cause; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw error ?? new Error(message);
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

test("large plain-text editor keeps its full source, edits and history through a virtual viewport", async t => {
  const configuredExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (configuredExecutable) throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    t.skip(`Chrome is not installed at ${executablePath}; browser-level large text checks were not run.`);
    return;
  }

  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-large-plain-text-"));
  let chrome;
  let socket;
  let server;
  try {
    chrome = spawn(executablePath, ["--headless=new", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-debugging-port=0", "--remote-allow-origins=*",
      `--user-data-dir=${profile}`, "about:blank"], {stdio: "ignore"});
    let launchError;
    chrome.on("error", error => { launchError = error; });
    const activePortFile = path.join(profile, "DevToolsActivePort");
    const browserWs = await waitFor(async () => {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null) throw new Error(`Chrome exited before startup (code ${chrome.exitCode}).`);
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
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.text);
        return;
      }
      const command = pending.commands.get(message.id);
      if (!command) return;
      pending.commands.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });
    server = await createServer({
      configFile: false, root: process.cwd(), appType: "mpa", plugins: [react()],
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
    await cdp("Emulation.setDeviceMetricsOverride", {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/large-plain-text.html`});
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? "unknown browser exception"}`);
      return result.result.value;
    };
    const fixture = (method, ...args) => evaluate(`window.__largePlainTextFixture.${method}(...${JSON.stringify(args)})`);
    const key = async (type, keyName, code, virtualKey, modifiers = 0) => cdp("Input.dispatchKeyEvent", {
      type, key: keyName, code, windowsVirtualKeyCode: virtualKey, modifiers,
    });
    const shortcut = async (keyName, code, virtualKey, modifiers) => {
      await key("keyDown", keyName, code, virtualKey, modifiers);
      await key("keyUp", keyName, code, virtualKey, modifiers);
    };
    const commandModifier = process.platform === "darwin" ? 4 : 2;

    await waitFor(() => fixture("snapshot").then(state => state.handleAvailable && state.modelLength !== null),
      "The real large plain-text editor did not become ready.");

    await t.test("loads a large document without emitting edits and renders only viewport lines", async () => {
      const state = await fixture("snapshot");
      assert.equal(state.isVirtual, true, "the real component selected its large-text path");
      assert.equal(state.changeCount, 0, "initial render and source normalization do not call onChange");
      assert.equal(state.modelLength, state.normalizedHostLength, "the complete normalized source remains in the CodeMirror document model");
      assert.equal(state.modelMatchesHost, true, "the model preserves BOM and normalizes line endings to LF");
      assert.equal(state.hostHasBom, true, "the persisted source keeps its UTF-8 BOM character");
      assert.equal(state.hostHasTerminalBlankLines, true, "the host source keeps its terminal blank lines");
      assert.ok(state.contentLength >= 300_000, `fixture is large enough (${state.contentLength} UTF-16 code units)`);
      assert.ok(state.modelLines >= 10_000, `model retains every line (${state.modelLines})`);
      assert.ok(state.visibleLineCount < 300, `only viewport lines are in the DOM (${state.visibleLineCount})`);
      assert.equal(state.sameEditorView, true, "the test bridge can reach the actual CodeMirror view from its DOM");
    });

    await t.test("echoes complete edits without rebuilding, and preserves undo and redo", async () => {
      const insertion = "粘贴片段\n第二行";
      await fixture("pasteAt", 1, insertion);
      await waitFor(() => fixture("snapshot").then(state => state.changeCount === 1), "The paste did not reach the host onChange callback.");
      let state = await fixture("snapshot");
      assert.equal(state.hostMatchesLastChange, true, "the host synchronously echoes the full onChange value");
      assert.equal(state.modelMatchesHost, true, "onChange returns the full current source");
      assert.equal(state.changedLength, state.modelLength, "the change callback includes the entire large document");
      assert.ok(state.hostPrefix.startsWith(`\uFEFF${insertion}`), "paste inserts after the BOM");
      assert.equal(state.sameEditorView, true, "the parent echo does not replace the live editor view");

      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("snapshot").then(value => value.changeCount === 2), "Undo did not emit the restored full source.");
      state = await fixture("snapshot");
      assert.ok(!state.hostPrefix.startsWith(`\uFEFF${insertion}`), "undo restores the previous large source");
      assert.equal(state.sameEditorView, true);

      await shortcut("z", "KeyZ", 90, commandModifier | 8);
      await waitFor(() => fixture("snapshot").then(value => value.changeCount === 3), "Redo did not emit the inserted source.");
      state = await fixture("snapshot");
      assert.ok(state.hostPrefix.startsWith(`\uFEFF${insertion}`), "redo restores the pasted text");
      assert.equal(state.sameEditorView, true);
    });

    await t.test("read-only and inactive tabs reject edits while retaining content and history", async () => {
      let state = await fixture("snapshot");
      const editableLength = state.contentLength;
      const editablePrefix = state.hostPrefix;
      await fixture("setProps", {readOnly: true});
      await waitFor(() => fixture("snapshot").then(value => value.editable === "false"), "Read-only mode did not disable editing.");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "blocked"});
      assert.deepEqual([(await fixture("snapshot")).contentLength, (await fixture("snapshot")).hostPrefix],
        [editableLength, editablePrefix], "read-only mode emits no content changes");

      await fixture("setProps", {readOnly: false, active: false});
      await waitFor(() => fixture("snapshot").then(value => value.editable === "false"), "Inactive tabs did not disable editing.");
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "blocked"});
      state = await fixture("snapshot");
      assert.deepEqual([state.contentLength, state.hostPrefix], [editableLength, editablePrefix],
        "inactive tabs emit no content changes");

      await fixture("setProps", {active: true});
      await waitFor(() => fixture("snapshot").then(value => value.editable === "true"), "Returning to the tab did not re-enable editing.");
      state = await fixture("snapshot");
      assert.deepEqual([state.contentLength, state.hostPrefix], [editableLength, editablePrefix],
        "switching tabs retains the full document");
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await waitFor(() => fixture("snapshot").then(value => value.changeCount > 3), "History did not survive the tab switch.");
      state = await fixture("snapshot");
      assert.ok(!state.hostPrefix.startsWith("\uFEFF粘贴片段\n第二行"), "undo after returning to the tab still reaches the prior edit");
      assert.equal(state.sameEditorView, true, "read-only toggles and tab switches retain the editor instance");
    });

    await t.test("accepts keyboard text and a committed Chinese IME composition", async () => {
      await fixture("focusAt", 1);
      await cdp("Input.insertText", {text: "typed-"});
      await waitFor(() => fixture("snapshot").then(state => state.hostPrefix.startsWith("\uFEFFtyped-")),
        "Keyboard text did not reach the large document.");

      await cdp("Input.imeSetComposition", {text: "拼音候选", selectionStart: 4, selectionEnd: 4});
      await cdp("Input.insertText", {text: "中文提交"});
      await waitFor(() => fixture("snapshot").then(state => state.hostPrefix.includes("中文提交")),
        "The committed Chinese IME text did not reach the host.");

      const state = await fixture("snapshot");
      assert.equal(state.modelMatchesHost, true, "the host echo and full editor model agree after input");
      assert.equal(state.hostMatchesLastChange, true, "onChange still carries the complete source");
      assert.equal(state.changedLength, state.modelLength, "IME input reports the full large document");
      assert.ok(state.hostPrefix.startsWith("\uFEFFtyped-"), "typing preserves the BOM at the start of the source");
      assert.equal(state.hostHasTerminalBlankLines, true, "typing and composition preserve terminal blank lines");
      assert.equal(state.sameEditorView, true, "input and host echo do not rebuild the editor");
    });

    await t.test("Cmd/Ctrl+F search locates a distant line without rendering the whole document", async () => {
      const target = "line-08999-";
      const beforeSearch = await fixture("snapshot");
      await fixture("focusAt", 1);
      await shortcut("f", "KeyF", 70, commandModifier);
      await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-search input'))`),
        "The CodeMirror search panel did not open.");
      await shortcut("a", "KeyA", 65, commandModifier);
      await cdp("Input.insertText", {text: target});
      // CodeMirror commits the search field on keyup/change, then Enter selects the next match.
      await shortcut("End", "End", 35, 0);
      await shortcut("Enter", "Enter", 13, 0);
      await waitFor(() => fixture("snapshot").then(state => state.searchInputValue === target
        && state.selectionLine === 9000), "Search did not select the unique match on line 9000.");
      const state = await fixture("snapshot");
      assert.equal(state.changeCount, beforeSearch.changeCount, "searching is not reported as a document edit");
      assert.equal(state.modelMatchesHost, true, "search preserves the complete source");
      assert.ok(state.visibleLineCount < 300, `search virtualization keeps the DOM bounded (${state.visibleLineCount})`);
      assert.equal(state.sameEditorView, true, "search keeps the same editor instance");
    });

    await t.test("Enter, Tab and Backspace retain plain-text behavior without code indentation", async () => {
      const prefix = "\uFEFF  正文";
      await fixture("setProps", {content: `${prefix}\n尾行\n`});
      await waitFor(() => fixture("snapshot", true).then(state => state.model === `${prefix}\n尾行\n`), "The keyboard sample did not load.");
      await fixture("focusAt", prefix.length);
      await shortcut("Enter", "Enter", 13, 0);
      await waitFor(() => fixture("snapshot", true).then(state => state.model === `${prefix}\n\n尾行\n`), "Enter added unexpected automatic indentation.");
      await shortcut("Tab", "Tab", 9, 0);
      await waitFor(() => fixture("snapshot", true).then(state => state.model === `${prefix}\n\t\n尾行\n`), "Tab did not insert the literal tab character.");
      await shortcut("Tab", "Tab", 9, 8);
      await waitFor(() => fixture("snapshot", true).then(state => state.model === `${prefix}\n\n尾行\n`), "Shift-Tab did not remove the preceding tab.");
      await fixture("setProps", {content: "\uFEFF    正文\n"});
      await waitFor(() => fixture("snapshot", true).then(state => state.model === "\uFEFF    正文\n"), "The backspace sample did not load.");
      await fixture("focusAt", 5);
      await shortcut("Backspace", "Backspace", 8, 0);
      await waitFor(() => fixture("snapshot", true).then(state => state.model === "\uFEFF   正文\n"), "Backspace deleted an indentation unit instead of one character.");
    });

    await t.test("external replacement resets stale history and failed conversion keeps the source", async () => {
      const replacement = "\uFEFFreplacement\n\n";
      await fixture("setProps", {content: replacement});
      await waitFor(() => fixture("snapshot", true).then(state => state.model === replacement), "External content replacement did not reach CodeMirror.");
      const changesBeforeUndo = (await fixture("snapshot")).changeCount;
      await fixture("focusAt", 1);
      await shortcut("z", "KeyZ", 90, commandModifier);
      await new Promise(resolve => setTimeout(resolve, 100));
      let state = await fixture("snapshot", true);
      assert.equal(state.model, replacement, "undo cannot restore an edit from before external replacement");
      assert.equal(state.changeCount, changesBeforeUndo, "external replacement itself is not reported as a user edit");
      assert.equal(state.sameEditorView, true, "external replacement updates the same view");

      await fixture("runConvert");
      await waitFor(() => fixture("snapshot").then(value => value.errorText === "fixture save-as failure"), "The failed save-as action did not report its error.");
      state = await fixture("snapshot");
      assert.equal(state.saveAsRequest?.extension, "lode", "the editor requests the expected converted document format");
      assert.ok(state.saveAsRequest?.contentLength, "the conversion request contains converted content");
      assert.equal(state.hostPrefix, replacement.slice(0, 40), "save-as failure leaves the source document unchanged");
      assert.equal(state.modelMatchesHost, true, "the original plain text remains available after save-as failure");
    });

    await t.test("unmount clears the ready handle and editor DOM", async () => {
      await fixture("unmount");
      await waitFor(() => evaluate(`document.querySelectorAll('.cm-editor').length === 0
        && document.querySelectorAll('.rich-text-editor-mount').length === 0`), "Unmount did not clear CodeMirror resources.");
      const state = await fixture("snapshot");
      assert.equal(state.handleAvailable, false, "the host handle is cleared during disposal");
      assert.equal(state.visibleLineCount, 0, "no virtual lines remain after disposal");
    });

    assert.deepEqual(pageErrors, [], "the browser reports no large plain-text editor exceptions");
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await bounded(new Promise(resolve => chrome.once("exit", resolve)), "Chrome shutdown").catch(() => {});
    }
    if (server) await bounded(server.close(), "Vite server shutdown").catch(() => {});
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
