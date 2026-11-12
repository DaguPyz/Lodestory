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

test("shortcut overlay isolation follows UI surfaces and releases after dismissal", async t => {
  const playwright = loadPlaywright();
  if (!playwright) return t.skip("Playwright is not installed in this runtime.");
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.LODESTORY_CHROME_PATH ? {executablePath: process.env.LODESTORY_CHROME_PATH} : {})});
  t.after(() => browser.close());
  const server = await createServer({
    cacheDir: "node_modules/.vite-shortcuts-overlays-test",
    resolve: {dedupe: ["react", "react-dom"]},
    optimizeDeps: {entries: ["tests/fixtures/project-index.html"], include: [
      "react", "react-dom/client", "@base-ui/react/context-menu", "@base-ui/react/dialog", "@base-ui/react/menu", "@base-ui/react/select",
    ]},
    server: {host: "127.0.0.1", port: 0, strictPort: false, hmr: false}, logLevel: "error",
  });
  t.after(() => server.close());
  await server.listen();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control");
  const pressShortcut = key => page.keyboard.press(`${modifier}+${key}`);
  const tabs = page.locator(".document-tab-select");
  const file = name => page.locator(".file-tree").getByRole("button", {name, exact: true});
  const editor = page.getByRole("textbox", {name: "文档正文", exact: true});

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/project-index.html`);
  await page.getByRole("button", {name: "打开项目 测试故事", exact: true}).click();
  await page.getByRole("heading", {name: "作品已打开", exact: true}).waitFor();
  if (!await file("已有章节.txt").isVisible()) await page.getByRole("button", {name: "工程文件", exact: true}).click();
  await file("已有章节.txt").dblclick();
  await editor.waitFor();
  await tabs.click({button: "right"});
  const menu = page.getByRole("menu", {name: "已有章节.txt标签操作", exact: true});
  await menu.waitFor();
  await pressShortcut("w");
  assert.equal(await tabs.count(), 1, "a context menu keeps the underlying document open");
  assert.equal(await menu.isVisible(), true, "the context menu remains active while the background shortcut is blocked");
  await page.keyboard.press("Escape");
  await menu.waitFor({state: "detached"});
  await editor.press(`${modifier}+n`);
  const dialog = page.getByRole("dialog", {name: "新建文档", exact: true});
  const name = page.getByLabel("文档名称", {exact: true});
  await dialog.waitFor();
  await name.fill("隔离验证");
  await pressShortcut("w");
  assert.equal(await tabs.count(), 1, "a Dialog keeps the underlying document open");
  assert.equal(await dialog.isVisible(), true, "the Dialog stays open while the background shortcut is blocked");
  assert.equal(await name.inputValue(), "隔离验证", "the Dialog keeps its input while the shortcut is blocked");
  await page.keyboard.press("Escape");
  await dialog.waitFor({state: "detached"});
  await pressShortcut("w");
  await tabs.waitFor({state: "detached"});

  await file("已有章节.txt").click();
  assert.equal(await tabs.count(), 0, "a single click selects the file without opening a tab");
  assert.equal(await file("已有章节.txt").getAttribute("data-selected"), "true");
  await page.keyboard.press("F2");
  await page.getByRole("dialog", {name: "重命名文件", exact: true}).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await file("已有章节.txt").evaluate(element => document.activeElement === element), true,
    "selection keeps keyboard focus on its tree entry");
  await page.keyboard.press("F2");
  await page.getByRole("dialog", {name: "重命名文件", exact: true}).waitFor();
  await page.keyboard.press("Escape");

  await file("正文").click();
  assert.equal(await file("正文").evaluate(element => document.activeElement === element), true,
    "clicking a folder focuses it even where pointer clicks do not focus buttons by default");
  await page.keyboard.press("F2");
  await page.getByRole("dialog", {name: "重命名文件夹", exact: true}).waitFor();
  await page.keyboard.press("Escape");

  await file("已有章节.txt").dblclick();
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.press("F2");
  assert.equal(await page.getByRole("dialog", {name: "重命名文件", exact: true}).count(), 0,
    "tree rename does not take F2 from the focused editor");

  let releaseTextEditor;
  const textEditorGate = new Promise(resolve => { releaseTextEditor = resolve; });
  t.after(() => releaseTextEditor());
  await page.route("**/src/plugins/plain-text-editor/PlainTextEditor.tsx*", async route => {
    await textEditorGate;
    await route.continue();
  });
  await file("故事大纲.txt").dblclick();
  await page.getByText("正在加载编辑器…", {exact: true}).waitFor();
  await file("已有章节.txt").click();
  releaseTextEditor();
  await page.getByRole("textbox", {name: "纯文本正文", exact: true}).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await file("已有章节.txt").evaluate(element => document.activeElement === element), true,
    "a delayed editor does not take focus back after another file is selected");
  await page.keyboard.press("F2");
  await page.getByRole("dialog", {name: "重命名文件", exact: true}).waitFor();
  await page.keyboard.press("Escape");

  await page.setViewportSize({width: 600, height: 800});
  await page.getByRole("button", {name: "工程文件", exact: true}).click();
  const tabsBeforeSelection = await tabs.count();
  await file("故事大纲.txt").click();
  assert.equal(await file("故事大纲.txt").isVisible(), true, "selection keeps the tree drawer open");
  assert.equal(await file("故事大纲.txt").getAttribute("data-selected"), "true");
  assert.equal(await tabs.count(), tabsBeforeSelection, "selecting another file does not open it");
  assert.equal(await file("故事大纲.txt").evaluate(element => document.activeElement === element), true);
  await page.keyboard.press("F2");
  await page.getByRole("dialog", {name: "重命名文件", exact: true}).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});
