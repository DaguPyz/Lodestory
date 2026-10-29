import assert from "node:assert/strict";
import {createRequire} from "node:module";
import path from "node:path";
import test from "node:test";
import {createServer} from "vite";

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(path.dirname(process.execPath), "../node_modules")]}));
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
}

test("project opens its locked workspace before the file tree is ready and recovers from load errors", async t => {
  const playwright = loadPlaywright();
  if (!playwright) return t.skip("Playwright is not installed in this runtime.");
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.LODESTORY_CHROME_PATH ? {executablePath: process.env.LODESTORY_CHROME_PATH} : {})});
  t.after(() => browser.close());
  const server = await createServer({cacheDir: "node_modules/.vite-workbench-loading-test",
    server: {host: "127.0.0.1", port: 0, hmr: false}, logLevel: "error"});
  await server.listen();
  t.after(() => server.close());
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/project-index.html`;

  await t.test("a slow tree keeps the visible workspace locked until the real request finishes", async () => {
    await page.goto(`${url}?scenario=project-loading-gate`);
    await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
    const layout = page.locator(".default-layout");
    await layout.waitFor();
    const progress = layout.locator('.layout-status progress[aria-label="工作台加载进度"]');
    await progress.waitFor();
    assert.equal(await layout.locator(".layout-status .workbench-status-loading").count(), 1,
      "project startup progress is rendered in the bottom status bar");
    assert.equal(await page.locator(".workbench-loading").count(), 0,
      "normal project startup does not create a floating progress card");
    assert.match((await layout.locator(".layout-status").innerText()).replace(/\s+/g, " "), /正在加载.*\d+\s*\/\s*\d+/,
      "the status bar shows the active task and its progress count");
    const toolbar = layout.locator(".layout-actions [role='toolbar']");
    await toolbar.waitFor();
    assert.equal(await toolbar.locator(".toolbar-brand").count(), 1,
      "the toolbar brand is visible before project participants finish loading");
    assert.equal(await toolbar.locator("[data-toolbar-project-name]").textContent(), "测试故事",
      "the project name is visible during startup");
    assert.ok(await toolbar.locator("button").evaluateAll(buttons => buttons.length > 0 && buttons.every(button => button.disabled)),
      "toolbar actions remain disabled until project startup finishes");
    if (process.env.LODESTORY_LOADING_SCREENSHOT) {
      await page.screenshot({path: process.env.LODESTORY_LOADING_SCREENSHOT});
    }
    assert.equal(await layout.evaluate(element => !!element.closest("[inert]")), true,
      "the workspace is inert while startup is pending");
    const navigationButton = layout.locator(".layout-activitybar button").first();
    await navigationButton.evaluate(element => element.focus());
    assert.equal(await navigationButton.evaluate(element => document.activeElement === element), false,
      "keyboard focus cannot enter the locked workspace");
    assert.equal(await page.locator(".file-tree").count(), 0, "the held tree has not been reported ready");
    await page.evaluate(() => window.__releaseProjectTree());
    await progress.waitFor({state: "detached"});
    await page.waitForFunction(() => document.querySelector('.file-tree button[title="故事大纲.txt"]')
      || document.querySelector('.workbench-loading [role="alert"]'));
    const loadError = await page.locator('.workbench-loading [role="alert"]').allTextContents();
    assert.deepEqual(loadError, [], `startup should succeed after releasing the tree: ${loadError.join(" ")}`);
    assert.equal(await page.locator(".workbench-status-loading").count(), 0,
      "the status-bar progress item disappears once startup finishes");
    await page.locator(".file-tree").getByRole("button", {name: "故事大纲.txt", exact: true}).click();
    await page.locator('.document-tab-select[aria-current="page"]').waitFor();
    assert.equal(await layout.evaluate(element => !!element.closest("[inert]")), false);
  });

  await t.test("failed initialization stays visible and can retry without leaving the workspace", async () => {
    await page.goto(`${url}?scenario=project-loading-error-once`);
    await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
    await page.getByText("模拟项目文件树读取失败。", {exact: false}).waitFor();
    assert.equal(await page.locator(".default-layout").count(), 0,
      "the failed candidate view is removed before its resources are released");
    await page.getByRole("button", {name: "重试加载", exact: true}).click();
    await page.locator(".file-tree").getByRole("button", {name: "故事大纲.txt", exact: true}).waitFor();
    assert.equal(await page.locator(".default-layout").evaluate(element => !!element.closest("[inert]")), false);
  });

  await t.test("failed initialization can return to the welcome page", async () => {
    await page.goto(`${url}?scenario=project-loading-error-once`);
    await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
    await page.getByText("模拟项目文件树读取失败。", {exact: false}).waitFor();
    await page.getByRole("button", {name: "返回", exact: true}).click();
    await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).waitFor();
    assert.equal(await page.locator('.layout-status progress[aria-label="工作台加载进度"]').count(), 0);
  });
});
