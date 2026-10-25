import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
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

async function waitFor(action, message, timeoutMs = 15000) {
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

test("timeline event associates assets by type, searches, preserves missing links and saves selections", async t => {
  const configuredExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (configuredExecutable) throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    t.skip(`Chrome is not installed at ${executablePath}; browser-level timeline asset checks were not run.`);
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-timeline-assets-"));
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
      configFile: false, root: process.cwd(), appType: "mpa",
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
    await cdp("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
    await cdp("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/timeline-asset-association.html`});
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? "unknown browser exception"}`);
      return result.result.value;
    };
    const capture = async name => {
      await waitFor(() => evaluate(`getComputedStyle(document.querySelector('.ui-dialog')).opacity === '1'`),
        "The dialog did not finish appearing before capture.");
      const screenshot = await cdp("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
      await writeFile(`/tmp/lodestory-timeline-assets-${name}.png`, Buffer.from(screenshot.data, "base64"));
    };
    const fixture = (method, ...args) => evaluate(`window.__timelineAssetFixture.${method}(...${JSON.stringify(args)})`);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
    const openFilter = async () => {
      await click('button[aria-label="资产分类"]');
      await waitFor(() => evaluate(`Boolean(document.querySelector('[role="option"]'))`), "Asset categories did not open.");
    };
    const searchFor = async text => evaluate(`(() => {
      const input = document.querySelector('input[aria-label="搜索资产"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    const clickButtonNamed = async name => {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(name)});
        if (!button) return false;
        button.click(); return true;
      })()`);
      assert.equal(clicked, true, `The '${name}' button is available.`);
    };
    const selectOption = async text => {
      const chosen = await evaluate(`(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === ${JSON.stringify(text)});
        if (!option) return false;
        option.click(); return true;
      })()`);
      assert.equal(chosen, true, `The '${text}' category option is available.`);
    };
    const selectAsset = async name => {
      const chosen = await evaluate(`(() => {
        const input = [...document.querySelectorAll('input[type="checkbox"]')]
          .find(item => item.closest('label')?.textContent.includes(${JSON.stringify(name)}));
        if (!input) return false;
        if (!input.checked) input.click();
        return input.checked;
      })()`);
      assert.equal(chosen, true, `The '${name}' asset can be selected.`);
    };
    const openEvent = async () => {
      await fixture("open");
      await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="资产分类"]'))`),
        "The timeline event editor did not open.");
    };
    const selectedIds = async () => fixture("events").then(events => events[0].assetIds);
    const selectionUnavailable = () => evaluate(`(() => {
      const checkbox = document.querySelector('.timeline-event-assets-results input[type="checkbox"][aria-label="陈师傅"]');
      return !checkbox || checkbox.disabled;
    })()`);

    await waitFor(() => evaluate("Boolean(window.__timelineAssetFixture)"), "The fixture did not start.");
    await openEvent();
    await capture("desktop-dark");
    await evaluate(`document.documentElement.dataset.uiThemeId = 'lodestory.builtin.light'`);
    await capture("desktop-light");
    await evaluate(`document.documentElement.dataset.uiThemeId = 'lodestory.builtin.dark'`);
    await cdp("Emulation.setDeviceMetricsOverride", {width: 420, height: 900, deviceScaleFactor: 1, mobile: false});
    await capture("narrow-dark");
    await evaluate(`document.querySelector('.ui-dialog').scrollTop = document.querySelector('.ui-dialog').scrollHeight`);
    await capture("narrow-dark-scroll");
    await evaluate(`document.querySelector('.ui-dialog').scrollTop = 0`);
    await cdp("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
    assert.equal(await evaluate(`document.body.innerText.includes('20000000-0000-4000-8000-000000000099')
      || /不可用|待确认|已删除|找不到资产/.test(document.body.innerText)`), true,
      "a missing linked asset remains represented in the editor");

    await fixture("catalogState", {loaded: false, loading: true, blocked: false, error: null});
    await waitFor(selectionUnavailable,
      "Catalog loading disables new asset selection.");
    await fixture("catalogState", {loaded: false, loading: false, blocked: true, error: "资产目录暂时不可用"});
    await waitFor(() => evaluate(`document.body.innerText.includes('资产目录暂时不可用')`), "Catalog errors should be visible.");
    assert.equal(await evaluate(`document.body.innerText.includes('20000000-0000-4000-8000-000000000099')
      || /待确认|不可用/.test(document.body.innerText)`), true,
      "catalog errors keep the existing linked asset visible");
    await fixture("failNextRetry");
    await clickButtonNamed("重试读取资产");
    await waitFor(async () => await fixture("retryAttempts") === 1, "The explicit catalog retry was not attempted.");
    assert.equal(await evaluate(`document.querySelector('.timeline-event-assets-error')?.textContent.includes('资产目录暂时不可用')`), true,
      "a failed retry keeps its warning visible");
    await fixture("catalogState", {loaded: true, loading: false, blocked: false, error: null});
    await waitFor(() => evaluate(`!document.querySelector('.timeline-event-assets-error')`),
      "External catalog recovery clears a stale retry warning.");
    await waitFor(() => evaluate(`document.querySelector('input[aria-label="陈师傅"]')?.disabled === false`),
      "External recovery restores catalog selection.");

    await openFilter();
    await selectOption("人物");
    await click('input[aria-label="搜索资产"]');
    await searchFor("完全不存在的资产");
    assert.equal(await evaluate(`document.querySelector('.timeline-event-assets-feedback')?.textContent.trim() === '没有匹配的资产。'`), true,
      "an unmatched search has an empty result message while preserving the selected section");
    await searchFor("住在旧街");
    await waitFor(() => evaluate(`document.body.innerText.includes('陈师傅')`), "Search should match asset descriptions.");
    await selectAsset("陈师傅");
    await searchFor("");
    await openFilter();
    await selectOption("地点");
    await selectAsset("旧街");
    const removeMissingLink = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-label^="移除关联："]')]
        .find(item => item.getAttribute('aria-label').includes('资产不可用')
          || item.getAttribute('aria-label').includes('20000000-0000-4000-8000-000000000099'));
      if (!button) return false;
      button.click(); return true;
    })()`);
    assert.equal(removeMissingLink, true, "the missing link can be explicitly removed");
    await clickButtonNamed("取消");
    const saveCountBeforeCancel = await fixture("saves");
    assert.equal(saveCountBeforeCancel, 0, "editing and canceling does not persist asset selections");
    assert.deepEqual(await selectedIds(), ["20000000-0000-4000-8000-000000000099"],
      "cancel keeps the stored event unchanged");

    await openEvent();
    await openFilter();
    await selectOption("人物");
    await selectAsset("陈师傅");
    await openFilter();
    await selectOption("地点");
    await selectAsset("旧街");
    await fixture("catalogState", {loaded: false, loading: false, blocked: true, error: "资产目录暂时不可用"});
    await waitFor(selectionUnavailable,
      "Catalog failure disables further selections.");
    const submitted = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button[type="submit"]')];
      const save = buttons.find(button => button.textContent.includes('保存事件'));
      if (!save || save.disabled) return false;
      save.click(); return true;
    })()`);
    assert.equal(submitted, true, "the edited event can be saved");
    await waitFor(async () => (await selectedIds()).length === 3, "The event did not save both new links with its existing missing link.");
    assert.deepEqual([...(await selectedIds())].sort(), ["20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000099"].sort(),
      "catalog errors do not discard the missing link when the event is saved");
    assert.equal(await fixture("saves"), 1);

    await openEvent();
    await fixture("catalogState", {loaded: true, loading: false, blocked: false, error: null});
    assert.equal(await evaluate(`(() => [...document.querySelectorAll('.timeline-event-assets-results input[type="checkbox"]')]
      .filter(item => item.checked).map(item => item.getAttribute('aria-label')).sort().join(',') === '旧街,陈师傅')()`), true,
      "saved links are selected when reopening the event");
    assert.deepEqual(pageErrors, [], "the browser reports no timeline asset editor errors");
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
