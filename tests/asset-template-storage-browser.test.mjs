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

async function openObjectContextMenu(send, evaluate, selector) {
  const point = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`), `The object '${selector}' did not appear.`);
  await send("Input.dispatchMouseEvent", {...point, type: "mousePressed", button: "right", clickCount: 1});
  await send("Input.dispatchMouseEvent", {...point, type: "mouseReleased", button: "right", clickCount: 1});
  const edit = `[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === "编辑对象")`;
  await waitFor(() => evaluate(`Boolean(${edit})`), "The object menu did not offer Edit.");
  return edit;
}

test("template rows and cards open the clicked object for editing", async t => {
  await withProjectPage(t, "asset-template-workspace", async ({send, evaluate, pageErrors}) => {
    await clickButton(evaluate, "打开项目 测试故事");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.layout-activitybar button[aria-label="资产管理"]'))`),
      "Asset management navigation did not appear.");
    await clickButton(evaluate, "资产管理");
    const people = `document.querySelector('.asset-type-list button[aria-label^="人物"]')`;
    await waitFor(() => evaluate(`Boolean(${people})`), "The people template did not load.");
    await evaluate(`${people}.click()`);

    const openEditor = async (selector, name) => {
      const edit = await openObjectContextMenu(send, evaluate, selector);
      assert.deepEqual(await evaluate(`[...(${edit}).closest('[role="menu"]').querySelectorAll('[role="menuitem"]')]
        .filter(item => item.querySelector('.context-menu-icon svg[aria-hidden="true"]'))
        .map(item => item.textContent.trim())`), ["新建对象", "模板设置", "编辑对象", "删除对象"]);
      await evaluate(`${edit}.click()`);
      await waitFor(() => evaluate(`document.querySelector('.asset-record-form input[aria-label="对象名称"]')?.value === ${JSON.stringify(name)}`),
        "The form did not load the right-clicked object.");
    };

    await openEditor('.asset-object-table button[aria-label="查看对象“林舟”"]', "林舟");
    await evaluate(`[...document.querySelectorAll('.asset-record-form-actions button')].find(button => button.textContent === "取消").click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector(".asset-object-table"))`), "Cancel did not return to the table.");

    await clickButton(evaluate, "卡片视图");
    await openEditor('.asset-object-card button[aria-label="查看对象“沈青萝”"]', "沈青萝");
    await evaluate(`(() => {
      const input = document.querySelector('.asset-record-form input[aria-label="对象名称"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "沈青萝（已编辑）");
      input.dispatchEvent(new Event("input", {bubbles: true}));
    })()`);
    await evaluate(`document.querySelector('.asset-record-form-actions button[type="submit"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.asset-object-card button[aria-label="查看对象“沈青萝（已编辑）”"]'))`),
      "Saving did not return to the cards with the edited object.");
    assert.deepEqual(pageErrors, []);
  });
});

test("asset relation panel searches both dropdowns, preserves drafts, and edits relations from either object", async t => {
  await withProjectPage(t, "asset-template-workspace-relation-once", async ({send, evaluate, pageErrors}) => {
    const panel = ".asset-relations-panel";
    const path = ".lodestory/asset-relations/relations.json";
    const savedRelations = `window.__projectFixture.readJson(${JSON.stringify(path)})?.relations ?? []`;
    const label = `${panel} .asset-relations-fields input`;
    const searchPopup = ".ui-select-popup--searchable[data-open]";
    const tagsPopup = ".asset-relations-tags-popup";
    const tags = `${tagsPopup} input`;
    const objectSave = ".asset-record-form-actions button[type=submit]";

    const clickText = async (selector, title) => {
      const item = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim() === ${JSON.stringify(title)} && !node.disabled)`;
      await waitFor(() => evaluate(`Boolean(${item})`), `Missing action: ${title}`);
      await evaluate(`${item}.click()`);
    };
    const typeIn = (selector, value) => evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", {bubbles: true}));
    })()`);
    const dropdown = position => `${panel} .asset-relations-fields > :nth-child(${position}) button[role=combobox]`;
    const pressKey = async (key, windowsVirtualKeyCode) => {
      const event = {key, code: key, windowsVirtualKeyCode};
      await send("Input.dispatchKeyEvent", {type: "keyDown", ...event, ...(key === "Enter" ? {text: "\r"} : {})});
      await send("Input.dispatchKeyEvent", {type: "keyUp", ...event});
    };
    const openDropdown = async (position, searchLabel) => {
      const selector = dropdown(position);
      const point = await evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        const rect = button.getBoundingClientRect();
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
      })()`);
      await send("Input.dispatchMouseEvent", {...point, type: "mousePressed", button: "left", clickCount: 1});
      await send("Input.dispatchMouseEvent", {...point, type: "mouseReleased", button: "left", clickCount: 1});
      await waitFor(() => evaluate(`document.activeElement.matches('${searchPopup} input[aria-label="${searchLabel}"]')`),
        `Search input '${searchLabel}' did not receive focus.`, 2500);
    };
    const results = () => evaluate(`Array.from(document.querySelectorAll('${searchPopup} [role=option]'), option => option.textContent.trim())`);
    const search = text => send("Input.insertText", {text});
    const openEditor = async (category, name) => {
      const categorySelector = `.asset-type-list button[aria-label^="${category}"]`;
      await waitFor(() => evaluate(`Boolean(document.querySelector('${categorySelector}'))`), `Missing category: ${category}`);
      await evaluate(`document.querySelector('${categorySelector}').click()`);
      const edit = await openObjectContextMenu(send, evaluate, `.asset-object-table button[aria-label="查看对象“${name}”"]`);
      await evaluate(`${edit}.click()`);
      await waitFor(() => evaluate(`Boolean(document.querySelector('${label}'))`), "The relation panel did not mount.");
    };
    const row = () => evaluate(`[...document.querySelectorAll('${panel} .asset-relations-row > *')].map(node => node.textContent)`);
    const relationFormBounds = () => evaluate(`Array.from(document.querySelectorAll(
      '.asset-relations-fields input, .asset-relations-fields [role=combobox], .asset-relations-actions button'), control => {
      const {x, y, width, height} = control.getBoundingClientRect();
      return [x, y, width, height];
    })`);
    const openTags = async name => {
      await clickText(`${panel} .asset-relations-options button`, name);
      await waitFor(() => evaluate(`Boolean(document.querySelector('${tags}'))`), "The optional tag editor did not open.");
    };
    const closeTags = async () => {
      await clickText(`${tagsPopup} button`, "完成");
      await waitFor(() => evaluate(`!document.querySelector('${tagsPopup}')`), "The optional tag editor did not close.");
    };

    await clickButton(evaluate, "打开项目 测试故事");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.layout-activitybar button[aria-label="资产管理"]'))`), "Asset navigation not available.");
    await clickButton(evaluate, "资产管理");
    await openEditor("人物", "林舟");
    await send("Emulation.setDeviceMetricsOverride", {width: 1920, height: 900, deviceScaleFactor: 1, mobile: false});
    const layout = () => evaluate(`(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      const form = document.querySelector('.asset-record-form');
      const {left, right, top, width, bottom} = form.getBoundingClientRect();
      const sidebar = bounds('.asset-record-edit-panels');
      const footer = bounds('.asset-record-form-actions');
      return {even: Math.abs(right - sidebar.left) < 1 && Math.abs(top - sidebar.top) < 1
        && Math.abs(width - sidebar.width) < 1 && Math.abs(bounds('.asset-record-basics').width - bounds('${panel}').width) < 1,
        scrollTop: form.scrollTop, fieldTop: bounds('.asset-record-basics').top,
        panelTop: bounds('${panel}').top, titleTop: bounds('.asset-record-editor h1').top,
        footerTop: footer.top, footerVisible: footer.top >= bottom && footer.bottom <= window.innerHeight,
        scrollPoint: {x: left + width / 2, y: top + (bottom - top) / 2}};
    })()`);
    const beforeScroll = await layout();
    assert.equal(beforeScroll.even, true, "the object form and relation panel split the editor evenly at desktop width");
    assert.equal(beforeScroll.footerVisible, true, "the save bar is visible before scrolling the form");
    await send("Input.dispatchMouseEvent", {type: "mouseWheel", ...beforeScroll.scrollPoint, deltaX: 0, deltaY: 640});
    const afterScroll = await waitFor(async () => {
      const current = await layout();
      return current.scrollTop > beforeScroll.scrollTop && current;
    }, "The form content did not scroll.");
    assert.ok(afterScroll.fieldTop < beforeScroll.fieldTop);
    assert.equal(afterScroll.titleTop, beforeScroll.titleTop);
    assert.equal(afterScroll.footerTop, beforeScroll.footerTop);
    assert.equal(afterScroll.panelTop, beforeScroll.panelTop);

    const emptyForm = await relationFormBounds();
    assert.equal(await evaluate(`document.querySelector('${dropdown(3)}').disabled`), true);
    await openDropdown(2, "搜索分类");
    assert.deepEqual(await relationFormBounds(), emptyForm, "opening search does not reflow the form");
    await search("不存在的分类");
    await waitFor(() => evaluate(`document.querySelector('${searchPopup} [role=status]')?.textContent === '没有匹配的选项'`),
      "Empty filter results should be announced.");
    assert.deepEqual(await results(), []);
    await pressKey("Escape", 27);
    await waitFor(() => evaluate(`document.activeElement.matches('${dropdown(2)}')`), "Escape should return focus to the category dropdown.");

    await pressKey("Enter", 13);
    await waitFor(() => evaluate(`document.activeElement.matches('${searchPopup} input')`), "Keyboard should reopen the category search.", 2500);
    assert.equal(await evaluate("document.activeElement.value"), "", "search terms reset between openings");
    await search("人");
    assert.deepEqual(await results(), ["人物"], "categories filter by partial name");
    await pressKey("Enter", 13);
    await openDropdown(3, "搜索对象");
    assert.deepEqual(await results(), ["沈青萝", "顾长风"], "only other objects in the selected category are shown");
    await search("书铺");
    assert.deepEqual(await results(), ["沈青萝"], "objects can also be found by description");
    await clickText(`${searchPopup} [role=option]`, "沈青萝");

    await typeIn(label, "林舟修习御风诀");
    await openDropdown(2, "搜索分类");
    await search("功");
    await clickText(`${searchPopup} [role=option]`, "功法");
    assert.equal(await evaluate(`document.querySelector('${dropdown(3)}').textContent.trim()`), "选对象");
    await openDropdown(3, "搜索对象");
    await search("风诀");
    await pressKey("Enter", 13);
    assert.deepEqual(await relationFormBounds(), emptyForm, "choosing an asset keeps the required fields and add button in place");
    assert.equal(await evaluate(`document.querySelector('${tagsPopup}')`), null);
    await openTags("添加标签");
    assert.deepEqual(await relationFormBounds(), emptyForm, "opening the optional tags does not reflow the form");
    await typeIn(tags, "修习者");
    await typeIn(`${tagsPopup} label:nth-of-type(2) input`, "功法");
    await pressKey("Escape", 27);
    await waitFor(() => evaluate(`!document.querySelector('${tagsPopup}')`), "Escape did not close the optional tag editor.");
    assert.deepEqual(await relationFormBounds(), emptyForm, "closing the optional tags keeps the main controls in place");
    await openTags("标签（2）");
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${tags}'), input => input.value)`), ["修习者", "功法"]);
    await closeTags();
    assert.equal(await evaluate(`document.querySelector('${objectSave}').disabled`), true);
    await evaluate(`document.querySelector('[data-toolbar-project-trigger]').click()`);
    await clickText('[data-toolbar-menu-item]', "返回欢迎页");
    await waitFor(() => evaluate(`document.querySelector('${label}')?.value === '林舟修习御风诀' && !document.querySelector('${label}').disabled`),
      "A rejected project change must preserve the relation draft.");

    await clickText(`${panel} button`, "添加关系");
    await waitFor(() => evaluate(`document.querySelector('${panel} [role=alert]')?.textContent.includes('模拟首次创建失败')`), "The save error was not reported.");
    assert.equal(await evaluate(`document.querySelector('${label}').value`), "林舟修习御风诀");
    assert.deepEqual(await evaluate(savedRelations), []);
    await clickText(`${panel} button`, "重试保存关系");
    await waitFor(() => evaluate(`(${savedRelations}).length === 1`), "Retry did not save the relation.");
    assert.deepEqual(await row(), ["林舟（修习者）", "林舟修习御风诀", "御风诀（功法）"]);
    assert.deepEqual(await evaluate(savedRelations), [{label: "林舟修习御风诀", assets: [
      {assetsId: "40000000-0000-4000-8000-000000000001", tag: "修习者"},
      {assetsId: "40000000-0000-4000-8000-000000000004", tag: "功法"},
    ]}]);

    await clickText(".asset-record-form-actions button", "取消");
    await openEditor("功法", "御风诀");
    assert.deepEqual(await row(), ["御风诀（功法）", "林舟修习御风诀", "林舟（修习者）"]);
    await clickButton(evaluate, "编辑与林舟的关系「林舟修习御风诀」");
    await openTags("标签（2）");
    await typeIn(tags, "入门功法");
    await closeTags();
    await clickText(`${panel} button`, "保存关系");
    await waitFor(async () => (await row()).join("").includes("入门功法"), "Editing from the other endpoint did not update its tag.");
    assert.equal((await evaluate(savedRelations)).length, 1);

    await send("Emulation.setDeviceMetricsOverride", {width: 768, height: 900, deviceScaleFactor: 1, mobile: false});
    await waitFor(() => evaluate(`(() => {
      const form = document.querySelector('.asset-record-form').getBoundingClientRect();
      const panel = document.querySelector('${panel}').getBoundingClientRect();
      return panel.top >= form.bottom && panel.right <= window.innerWidth;
    })()`), "The panel should stack without horizontal overflow at narrow widths.");
    await clickButton(evaluate, "收起资产管理");
    await clickText(".asset-editor-panels-jump button", "查看资产关系");
    await waitFor(() => evaluate(`!document.querySelector('.layout-navigation[data-open="true"]')`), "Asset navigation did not close.");
    await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: false});
    const narrowChrome = () => evaluate(`['.asset-record-editor h1', '.asset-record-form-actions'].map(selector =>
      document.querySelector(selector).getBoundingClientRect().top)`);
    const beforeJump = await narrowChrome();
    await clickText(".asset-editor-panels-jump button", "查看资产关系");
    assert.equal(await evaluate(`document.activeElement === document.querySelector('.asset-record-edit-panels')`), true);
    assert.deepEqual(await narrowChrome(), beforeJump, "jumping to the relation panel keeps the title and save bar in place");
    await evaluate(`document.querySelector('${dropdown(2)}').scrollIntoView({block: 'center', behavior: 'instant'})`);
    await openDropdown(2, "搜索分类");
    await waitFor(() => evaluate(`(() => {
      const {left, right, top, bottom} = document.querySelector('${searchPopup}').getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
    })()`), "Search popup should stay within the narrow viewport.");
    await pressKey("Escape", 27);
    await clickButton(evaluate, "删除与林舟的关系「林舟修习御风诀」");
    await clickText('[role=dialog] button', "删除关系");
    await waitFor(() => evaluate(`Boolean(document.querySelector('${panel} .asset-relations-empty'))`), "The relation was not removed.");
    assert.deepEqual(await evaluate(savedRelations), []);
    assert.deepEqual(pageErrors, []);
  });
});

test("the assembled timeline displays stored asset relations without editing the project", async t => {
  await withProjectPage(t, "asset-template-workspace-timeline-relations", async ({send, evaluate, pageErrors}) => {
    const path = ".lodestory/asset-relations/relations.json";
    const savedRelations = `window.__projectFixture.readJson(${JSON.stringify(path)})`;
    await clickButton(evaluate, "打开项目 测试故事");
    await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="大纲设计"]'))`), "The outline did not become available.");
    await clickButton(evaluate, "大纲设计");
    await waitFor(() => evaluate(`document.querySelector('.outline-design-entry strong')?.textContent === '归乡之路'`), "The project timeline was not loaded.");
    await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
    await evaluate(`document.querySelector('.outline-design-entry').click()`);
    const endpoint = '[data-timeline-event-id="bbbbbbbb-bbbb-4bbb-8bbb-000000000003"] .timeline-event-endpoint';
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(endpoint)}))`), "The event did not appear.");
    await evaluate(`document.querySelector(${JSON.stringify(endpoint)}).focus()`);
    await send("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32});
    await send("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32});
    const asset = '.timeline-focus-asset-node[aria-label="查看「林舟」的资产关系"]';
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(asset)}))`), "The event asset has no relationship entry point.");
    const before = await evaluate(savedRelations);
    await evaluate(`document.querySelector(${JSON.stringify(asset)}).click()`);
    assert.equal(await evaluate(`document.querySelector('.timeline-focus-relation-name').textContent`), "林舟");
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.timeline-focus-relation-label'), node => node.textContent)`), ["师徒", "旧友"]);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.timeline-focus-asset-name'), node => node.textContent)`), ["顾长风", "沈青萝"]);
    assert.deepEqual(await evaluate(savedRelations), before);
    assert.deepEqual(pageErrors, []);
  });
});

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
    const templateFieldPaths = [peopleId, artsId].map(id => `.lodestory/assets/templates/${id}.json`);
    const beforeSchema = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(schemaPath)})`);
    const beforeTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const beforeGroups = await evaluate(`[${groupPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    const beforeTemplateFields = await evaluate(`[${templateFieldPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    const beforeCalls = await evaluate("window.__projectFixture.calls()");
    assert.equal(beforeSchema, null, "a current project loads without a schema file");
    assert.ok(Array.isArray(beforeTemplates), "the browser fixture loads the standalone top-level template list");
    assert.ok(beforeGroups.every(group => group && Array.isArray(group.assets) && Array.isArray(group.fields)
      && group.fields.every(field => field.owner.kind === "asset")),
    "object files contain objects and only object-owned fields");
    assert.ok(beforeTemplateFields.every(file => file && Array.isArray(file.fields)
      && file.fields.every(field => field.owner.kind === "type")),
    "each template has a separate file for its shared fields");

    const backButton = `document.querySelector(".asset-record-editor .asset-editor-back button")`;
    await evaluate(`document.querySelector('.asset-type-list button[aria-label^="人物"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.asset-record-editor button[aria-label="卡片视图"]'))`),
      "The current template's object list did not appear.");
    await clickButton(evaluate, "卡片视图");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.asset-object-card button[aria-label="查看对象“林舟”"]'))`),
      "The current template's cards did not appear.");
    await clickButton(evaluate, "查看对象“林舟”");
    await waitFor(() => evaluate(`${backButton}?.textContent.trim() === "返回人物列表"`),
      "The object detail did not show its return button.");
    const detailLayout = () => evaluate(`(() => {
      const button = ${backButton}.getBoundingClientRect();
      const title = document.querySelector(".asset-record-editor .asset-editor-heading-with-back h1").getBoundingClientRect();
      const fields = document.querySelector(".asset-record-editor .asset-property-values").getBoundingClientRect();
      return {sameRow: button.top < title.bottom && title.top < button.bottom && button.left > title.left,
        aligned: Math.abs(button.right - fields.right) < 1};
    })()`);
    assert.deepEqual(await detailLayout(), {sameRow: true, aligned: true}, "the return button shares the title row and aligns with the fields");
    await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 800, deviceScaleFactor: 1, mobile: false});
    await waitFor(async () => {
      const {sameRow, aligned} = await detailLayout();
      return !sameRow && aligned;
    }, "The button should wrap and stay aligned in a narrow pane.");
    await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    assert.equal(await evaluate(`(() => {
      const button = ${backButton};
      button.focus();
      return document.activeElement === button && !button.disabled;
    })()`), true, "the return button is available to the keyboard");
    const space = {key: " ", code: "Space", windowsVirtualKeyCode: 32};
    await send("Input.dispatchKeyEvent", {type: "keyDown", ...space});
    await send("Input.dispatchKeyEvent", {type: "keyUp", ...space});
    await waitFor(() => evaluate(`document.querySelector(".asset-records-heading h1")?.textContent === "人物"
      && Boolean(document.querySelector(".asset-object-card"))`), "Return should preserve the selected template and card view.");
    assert.equal(await evaluate(`document.activeElement === document.querySelector(".asset-record-editor")`), true,
      "keyboard focus returns to the object list");

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
    const templateSaveCount = calls => calls.filter(call => call.command === "save_project_file" && call.path === templatesPath).length;
    assert.equal(afterSchema, null, "template reordering does not create a schema file");
    const afterGroups = await evaluate(`[${groupPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    const afterTemplateFields = await evaluate(`[${templateFieldPaths.map(path => `window.__projectFixture.readJson(${JSON.stringify(path)})`).join(",")}]`);
    assert.deepEqual(afterGroups, beforeGroups, "template reordering leaves every object file unchanged");
    assert.deepEqual(afterTemplateFields, beforeTemplateFields, "template reordering leaves shared template fields unchanged");
    assert.deepEqual(afterTemplates.map(({id, name, description, order, status}) => [id, name, description, order, status]), [
      ["10000000-0000-4000-8000-000000000002", "功法", "修炼与施展的方法", 0, "active"],
      ["10000000-0000-4000-8000-000000000001", "人物", "故事中的角色", 1, "active"],
    ]);
    assert.equal(templateSaveCount(afterCalls), templateSaveCount(beforeCalls) + 1, "reordering saves templates.json once");

    const settingsBack = `document.querySelector(".asset-template-settings .asset-editor-back button")`;
    await waitFor(() => evaluate(`${settingsBack}?.textContent.trim() === "返回功法列表" && !${settingsBack}.disabled`),
      "The template settings should show its return button once saving finishes.");
    assert.equal(await evaluate(`(() => {
      const button = ${settingsBack}.getBoundingClientRect();
      const title = document.querySelector(".asset-template-settings h1").getBoundingClientRect();
      const fields = document.querySelector(".asset-template-settings .asset-fields-scroll").getBoundingClientRect();
      return button.left > title.right && button.top < title.bottom && title.top < button.bottom
        && Math.abs(button.right - fields.right) < 1;
    })()`), true, "the template return button shares the title row and aligns with the field area");
    await evaluate(`${settingsBack}.click()`);
    await waitFor(() => evaluate(`(() => {
      const list = document.querySelector(".asset-records-heading h1");
      return list?.textContent === "功法" && !list.closest("[hidden], [inert]");
    })()`), "Return should open the same template's object list.");
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
    const templatesPath = ".lodestory/assets/templates.json";
    const targetId = "10000000-0000-4000-8000-000000000001";
    const targetFieldId = "20000000-0000-4000-8000-000000000001";
    const targetFieldPath = `.lodestory/assets/templates/${targetId}.json`;
    const originalTemplateFields = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(targetFieldPath)})`);
    assert.ok(originalTemplateFields.fields.some(field => field.id === targetFieldId), "the template initially owns the field to be removed");
    assert.equal(await evaluate(`window.__projectFixture.readJson(${JSON.stringify(`.lodestory/assets/objects/${targetId}.json`)})`), null,
      "template fields alone do not create an object file");
    const callsBeforeDelete = await evaluate("window.__projectFixture.calls()");
    await evaluate(`${confirm}.click()`);
    const alert = await waitFor(() => evaluate(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.trim()`),
      "The injected template-list write failure was not displayed.");
    assert.match(alert, /类型删除保存失败：模拟首次写入失败，请重试。/);

    const pendingTemplates = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(templatesPath)})`);
    const cleanedTemplateFields = await evaluate(`window.__projectFixture.readJson(${JSON.stringify(targetFieldPath)})`);
    const failedCalls = (await evaluate("window.__projectFixture.calls()")).slice(callsBeforeDelete.length);
    assert.ok(pendingTemplates.some(template => template.id === targetId), "the template remains when the template-list save fails");
    assert.ok(!cleanedTemplateFields.fields.some(field => field.id === targetFieldId), "the shared field is saved before the template record is removed");
    assert.deepEqual(failedCalls.filter(call => call.command === "save_project_file").map(call => call.path),
      [targetFieldPath, templatesPath], "the shared fields are saved before the template-list save fails");

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
