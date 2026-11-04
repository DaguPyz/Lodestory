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

test("shortcut settings record, persist, reject conflicts, and restore a working binding", async t => {
  const playwright = loadPlaywright();
  if (!playwright) return t.skip("Playwright is not installed in this runtime.");
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.LODESTORY_CHROME_PATH ? {executablePath: process.env.LODESTORY_CHROME_PATH} : {})});
  t.after(() => browser.close());
  const server = await createServer({
    cacheDir: "node_modules/.vite-shortcut-settings-test",
    resolve: {dedupe: ["react", "react-dom"]},
    server: {host: "127.0.0.1", port: 0, strictPort: false, hmr: false},
    logLevel: "error",
  });
  t.after(() => server.close());
  await server.listen();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control");
  const row = () => page.locator(".shortcut-settings-row").filter({hasText: "新建文档"});
  const openSettings = async () => {
    await page.getByRole("button", {name: "设置", exact: true}).click();
    await page.getByRole("button", {name: "快捷键", exact: true}).click();
  };
  const edit = async () => {
    await row().getByRole("button", {name: "修改新建文档的快捷键"}).click();
    await page.getByLabel("新建文档的新快捷键").waitFor();
  };

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/project-index.html?scenario=save-as-conflict`);
  await openSettings();
  await edit();
  await page.getByLabel("新建文档的新快捷键").press(`${modifier}+Shift+N`);
  await row().getByRole("button", {name: "保存", exact: true}).click();
  await row().getByText(modifier === "Meta" ? "⌘ ⇧ N" : "Ctrl + Shift + N", {exact: true}).waitFor();

  await edit();
  await page.getByLabel("新建文档的新快捷键").press(`${modifier}+Shift+F`);
  await row().getByRole("button", {name: "保存", exact: true}).click();
  await page.getByRole("alert").getByText(/与「搜索项目资源」冲突/).waitFor();
  assert.equal(await row().getByText(modifier === "Meta" ? "⌘ ⇧ N" : "Ctrl + Shift + N", {exact: true}).count(), 1);
  await row().getByRole("button", {name: "取消", exact: true}).click();

  await page.reload();
  await openSettings();
  await row().getByText(modifier === "Meta" ? "⌘ ⇧ N" : "Ctrl + Shift + N", {exact: true}).waitFor();
  await page.getByRole("button", {name: "关闭", exact: true}).click();
  await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
  await page.getByRole("heading", {name: "作品已打开"}).waitFor();
  await page.keyboard.press(`${modifier}+Shift+N`);
  await page.getByRole("dialog", {name: "新建文档"}).waitFor();
  await page.keyboard.press("Escape");

  await openSettings();
  await edit();
  await row().getByRole("button", {name: "清除快捷键"}).click();
  await row().getByText("未设置", {exact: true}).waitFor();
  await edit();
  await row().getByRole("button", {name: "恢复默认"}).click();
  await row().getByText(modifier === "Meta" ? "⌘ N" : "Ctrl + N", {exact: true}).waitFor();
});
