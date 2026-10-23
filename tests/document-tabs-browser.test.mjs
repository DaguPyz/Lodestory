import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {createServer} from "vite";

test("tab context menus close the requested range and disable empty ranges", async t => {
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(path.dirname(process.execPath), "../node_modules")]}));
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    t.skip("Playwright is not installed in this runtime."); return;
  }
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.LODESTORY_CHROME_PATH ? {executablePath: process.env.LODESTORY_CHROME_PATH} : {})});
  t.after(() => browser.close());
  const server = await createServer({cacheDir: "node_modules/.vite-document-tabs-test",
    server: {host: "127.0.0.1", port: 0, strictPort: false, hmr: false}, logLevel: "error"});
  await server.listen();
  t.after(() => server.close());
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/project-index.html`;
  const names = ["故事大纲.txt", "第一章.txt", "第二章.txt", "第三章.txt"];
  const tabs = page.locator(".document-tab-select");
  const tab = name => page.locator(".document-tabs").getByTitle(name, {exact: true});
  const item = name => page.getByRole("menuitem", {name, exact: true});
  async function openMenu(name) {
    await tab(name).click({button: "right"});
    await page.getByRole("menu", {name: `${name}标签操作`, exact: true}).waitFor();
  }
  async function assertTabs(expected) {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll(".document-tab-select")]
      .map(element => element.title)) === JSON.stringify(expected), expected);
    assert.deepEqual(await tabs.evaluateAll(elements => elements.map(element => element.title)), expected);
  }
  async function createTabs(scenario = "") {
    await page.goto(`${baseUrl}${scenario ? `?scenario=${scenario}` : ""}`);
    await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
    await page.locator(".file-tree").getByRole("button", {name: names[0], exact: true}).click();
    for (const name of names.slice(1)) {
      await page.locator(".file-tree").getByRole("button", {name: "测试故事", exact: true}).click({button: "right"});
      await item("新建文档").click();
      await page.getByRole("dialog", {name: "新建文档", exact: true}).waitFor();
      await page.getByLabel("文档名称", {exact: true}).fill(name);
      await page.getByLabel("文档名称", {exact: true}).press("Enter");
      await page.getByRole("dialog").waitFor({state: "detached"});
      await tab(name).waitFor();
    }
    await assertTabs(names);
  }
  async function capture(name) {
    if (!process.env.LODESTORY_UI_SCREENSHOTS) return;
    await mkdir(process.env.LODESTORY_UI_SCREENSHOTS, {recursive: true});
    await page.evaluate(() => Promise.allSettled(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    await page.screenshot({path: path.join(process.env.LODESTORY_UI_SCREENSHOTS, `${name}.png`)});
  }

  await createTabs();
  await openMenu(names[2]);
  await page.getByRole("button", {name: "布局内容", exact: true}).click();
  await page.getByRole("menuitem", {name: "隐藏正文编辑", exact: true}).click();
  await assertTabs([]);
  await page.getByRole("menu", {name: `${names[2]}标签操作`, exact: true}).waitFor({state: "detached"});
  await page.getByRole("menuitem", {name: "显示正文编辑", exact: true}).click();
  await assertTabs(names);
  assert.equal(await tab(names[3]).getAttribute("aria-current"), "page", "returning to the body restores the selected document");
  await page.keyboard.press("Escape");

  await openMenu(names[2]);
  assert.equal(await tab(names[3]).getAttribute("aria-current"), "page", "right-clicking a background tab preserves the active tab");
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["保存", "关闭", "关闭全部", "关闭其他", "关闭左侧", "关闭右侧"]);
  await capture("document-tabs-menu-dark");
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "设置", exact: true}).click();
  await page.locator('input[value="lodestory.builtin.light"]').check();
  await page.getByRole("button", {name: "返回", exact: true}).click();
  await page.getByRole("button", {name: "返回", exact: true}).waitFor({state: "hidden"});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await openMenu(names[2]);
  await capture("document-tabs-menu-light");
  await page.keyboard.press("Escape");

  for (const [action, expected] of [
    ["关闭左侧", names.slice(2)],
    ["关闭右侧", names.slice(0, 3)],
    ["关闭其他", [names[2]]],
    ["关闭全部", []],
  ]) {
    if (await tabs.count()) {
      await openMenu(await tabs.first().getAttribute("title"));
      await item("关闭全部").click();
      await assertTabs([]);
    }
    for (const name of names) await page.locator(".file-tree").getByRole("button", {name, exact: true}).click();
    await assertTabs(names);
    await openMenu(names[2]);
    await item(action).click();
    await assertTabs(expected);
  }

  await page.locator(".file-tree").getByRole("button", {name: names[0], exact: true}).click();
  await openMenu(names[0]);
  for (const action of ["关闭其他", "关闭左侧", "关闭右侧"]) assert.equal(await item(action).getAttribute("aria-disabled"), "true");
  assert.notEqual(await item("关闭全部").getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await page.locator(".file-tree").getByRole("button", {name: names[1], exact: true}).click();
  await openMenu(names[0]);
  assert.equal(await item("关闭左侧").getAttribute("aria-disabled"), "true");
  assert.notEqual(await item("关闭右侧").getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await openMenu(names[1]);
  assert.notEqual(await item("关闭左侧").getAttribute("aria-disabled"), "true");
  assert.equal(await item("关闭右侧").getAttribute("aria-disabled"), "true");

  await createTabs("save-error");
  await tab(names[1]).click();
  const editor = page.getByRole("textbox", {name: "纯文本正文", exact: true});
  await editor.fill("批量关闭时必须保留的草稿");
  await openMenu(names[3]);
  await item("关闭全部").click();
  await assertTabs(names.slice(1));
  await page.getByRole("menu").waitFor({state: "detached"});
  assert.equal(await tab(names[1]).getAttribute("aria-current"), "page");
  assert.match(await editor.innerText(), /批量关闭时必须保留的草稿/);
  assert.deepEqual(errors, []);
});
