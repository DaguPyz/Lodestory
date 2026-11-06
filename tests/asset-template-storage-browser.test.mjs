import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {createServer} from "vite";

function browserPath() {
  return process.env.LODESTORY_CHROME_PATH ?? process.env.CHROME_EXECUTABLE_PATH
    ?? process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

function sendCdpCommand(socket, pending, method, params = {}, sessionId) {
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

async function withProjectPage(t, scenario, action) {
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (process.env.LODESTORY_CHROME_PATH || process.env.CHROME_EXECUTABLE_PATH || process.env.CHROME_PATH) {
      throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    }
    t.skip(`Chrome is not installed at ${executablePath}; browser-level template-storage checks were not run.`);
    return;
  }

  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-template-storage-"));
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
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, {once: true});
      socket.addEventListener("error", reject, {once: true});
    });

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
      cacheDir: path.join(profile, "vite-cache"),
      server: {host: "127.0.0.1", port: 0, strictPort: false, hmr: false},
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const target = await sendCdpCommand(socket, pending, "Target.createTarget", {url: "about:blank"});
    const attachment = await sendCdpCommand(socket, pending, "Target.attachToTarget", {targetId: target.targetId, flatten: true});
    const sessionId = attachment.sessionId;
    const send = (method, params = {}) => sendCdpCommand(socket, pending, method, params, sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await send("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/project-index.html?scenario=${scenario}`});

    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor(() => evaluate(`document.readyState === "complete" && Boolean(document.querySelector('button[aria-label="打开项目 测试故事"]'))`),
      "The project fixture did not finish loading.");
    await action({send, evaluate, pageErrors});
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise(resolve => {
        if (chrome.exitCode !== null) resolve();
        else chrome.once("exit", resolve);
      });
      chrome.kill("SIGTERM");
      await exited;
    }
    await server?.close();
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}

async function clickButton(evaluate, name) {
  const selector = JSON.stringify(name);
  assert.equal(await evaluate(`(() => { const button = [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === ${selector}); if (!button) return false; button.click(); return true; })()`), true,
    `Button '${name}' should be present and clickable.`);
}

async function rightClickTemplate(evaluate, name) {
  const label = JSON.stringify(name);
  return evaluate(`(() => {
    const button = [...document.querySelectorAll(".asset-type-list .asset-type-entry")]
      .find(item => item.textContent.includes(${label}));
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  })()`);
}

test("template reorder saves the standalone template list without rewriting asset data", async t => {
  await withProjectPage(t, "asset-template-workspace", async ({send, evaluate, pageErrors}) => {
    await clickButton(evaluate, "打开项目 测试故事");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.layout-activitybar button[aria-label="资产管理"]'))`),
      "Asset management navigation did not appear.");
    await clickButton(evaluate, "资产管理");
    const templateStatus = await waitFor(() => evaluate(`(() => {
      const list = document.querySelector(".asset-type-list");
      if (list?.querySelector('[aria-label^="人物"]') && list?.querySelector('[aria-label^="功法"]')) return "ready";
      const alert = document.querySelector('.asset-navigation [role="alert"]');
      if (alert) return "error: " + alert.textContent;
      const message = document.querySelector('.asset-navigation [role="status"]');
      return message ? message.textContent : null;
    })()`), "Standalone template records did not load.");
    assert.equal(templateStatus, "ready", templateStatus);

    const schemaPath = ".lodestory/assets/schema.json";
    const templatesPath = ".lodestory/assets/templates.json";
    const peopleId = "10000000-0000-4000-8000-000000000001";
    const artsId = "10000000-0000-4000-8000-000000000002";
    const groupPaths = [peopleId, artsId, "unclassified"].map(id => `.lodestory/assets/objects/${id}.json`);
    const beforeSchema = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(schemaPath)})`);
    const beforeTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const beforeGroups = await evaluate(`[${groupPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    const beforeCalls = await evaluate("window.__projectFixture.calls()");
    assert.equal(beforeSchema.schemaVersion, 4);
    assert.deepEqual(beforeSchema.groups, [peopleId, artsId, null]);
    assert.equal(Object.hasOwn(beforeSchema, "assets"), false, "the manifest stores no object records");
    assert.ok(Array.isArray(beforeTemplates), "the browser fixture loads the standalone top-level template list");
    assert.ok(beforeGroups.every(group => group && Array.isArray(group.assets) && Array.isArray(group.fields)),
      "objects and their fields are stored by template ID");

    const point = await rightClickTemplate(evaluate, "功法");
    assert.ok(point, "the target template row exists");
    await send("Input.dispatchMouseEvent", {...point, type: "mousePressed", button: "right", clickCount: 1});
    await send("Input.dispatchMouseEvent", {...point, type: "mouseReleased", button: "right", clickCount: 1});
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === "模板设置"))`),
      "The template context menu did not open.");
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === "模板设置").click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.asset-template-settings button[aria-label="上移模板“功法”"]'))`),
      "The template order control did not appear.");
    await clickButton(evaluate, "上移模板“功法”");
    await waitFor(() => evaluate(`(() => {
      const templates = window.__projectFixture.readJson(${JSON.stringify(templatesPath)});
      return templates?.find(template => template.name === "功法")?.order === 0
        && templates?.find(template => template.name === "人物")?.order === 1;
    })()`), "The standalone template list was not reordered.");

    const afterSchema = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(schemaPath)})`);
    const afterTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const afterCalls = await evaluate("window.__projectFixture.calls()");
    const schemaSaveCount = calls => calls.filter(call => call.command === "save_project_file" && call.path === schemaPath).length;
    const templateSaveCount = calls => calls.filter(call => call.command === "save_project_file" && call.path === templatesPath).length;
    assert.deepEqual(afterSchema, beforeSchema, "the manifest remains unchanged after reordering");
    const afterGroups = await evaluate(`[${groupPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    assert.deepEqual(afterGroups, beforeGroups, "template reordering leaves every object group unchanged");
    assert.deepEqual(afterTemplates.map(({id, name, description, order, status}) => [id, name, description, order, status]), [
      ["10000000-0000-4000-8000-000000000002", "功法", "修炼与施展的方法", 0, "active"],
      ["10000000-0000-4000-8000-000000000001", "人物", "故事中的角色", 1, "active"],
    ]);
    assert.equal(schemaSaveCount(afterCalls), schemaSaveCount(beforeCalls), "reordering does not save schema.json");
    assert.equal(templateSaveCount(afterCalls), templateSaveCount(beforeCalls) + 1, "reordering saves templates.json once");
    assert.deepEqual(pageErrors, []);
  });
});

test("template deletion waits for field cleanup and retries the template-list write", async t => {
  await withProjectPage(t, "asset-types-delete-save-once", async ({send, evaluate, pageErrors}) => {
    await clickButton(evaluate, "打开项目 测试故事");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.layout-activitybar button[aria-label="资产管理"]'))`),
      "Asset management navigation did not appear.");
    await clickButton(evaluate, "资产管理");
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.asset-type-list .asset-type-entry')].find(item => item.textContent.includes("兵器")))`),
      "The template records did not load.");
    const point = await rightClickTemplate(evaluate, "兵器");
    assert.ok(point, "the removable template exists");
    await send("Input.dispatchMouseEvent", {...point, type: "mousePressed", button: "right", clickCount: 1});
    await send("Input.dispatchMouseEvent", {...point, type: "mouseReleased", button: "right", clickCount: 1});
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === "删除模板"))`),
      "The template context menu did not open.");
    await evaluate(`([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === "删除模板")).click()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('[role="dialog"]')].find(item => item.textContent.includes("删除资产模板")))`),
      "The deletion confirmation did not appear.");
    const confirm = `([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === "确认删除"))`;
    await evaluate(`${confirm}.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[role="dialog"] [role="alert"]'))`),
      "The injected template-list write failure was not displayed.");

    const schemaPath = ".lodestory/assets/schema.json";
    const templatesPath = ".lodestory/assets/templates.json";
    const targetId = "10000000-0000-4000-8000-000000000001";
    const targetFieldId = "20000000-0000-4000-8000-000000000001";
    const targetGroupPath = `.lodestory/assets/objects/${targetId}.json`;
    const pendingTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const cleanedGroup = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(targetGroupPath)})`);
    assert.ok(pendingTemplates.some(template => template.id === targetId), "the template remains until field cleanup is durable");
    assert.ok(!cleanedGroup.fields.some(field => field.id === targetFieldId), "the owned field is saved before the template record is removed");

    const retry = `([...document.querySelectorAll('[role="dialog"] button')].find(button => /确认删除|重试保存/.test(button.textContent.trim())))`;
    await evaluate(`${retry}.click()`);
    await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`), "The template deletion did not complete after retry.");
    const savedTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const calls = await evaluate("window.__projectFixture.calls()");
    assert.ok(!savedTemplates.some(template => template.id === targetId), "retry completes the standalone list update");
    assert.equal(calls.filter(call => call.command === "save_project_file" && call.path === templatesPath).length, 2,
      "the failed template-list save is retried through the same file path");
    assert.deepEqual(pageErrors, []);
  });
});
