import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

describe("TXT-only document editor", () => {
  it("creates and saves TXT documents while rejecting Markdown and .lode files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-txt-editor-"));
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 10000});
      assert.equal(await browser.execute(parentPath => window.__lodestoryLifecycleTest.openTemporaryProject(parentPath), parent), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        return !!state.session && !state.busy && !state.loading;
      }), {timeout: 10000});

      const directory = path.join(parent, "生命周期测试");
      const markdownSource = "# 普通文本文件内容\n";
      const richTextSource = "不支持的旧格式内容";
      await writeFile(path.join(directory, "不可用.md"), markdownSource);
      await writeFile(path.join(directory, "旧格式.lode"), richTextSource);

      await browser.execute(() => window.__lodestoryLifecycleTest.createDocument());
      await browser.execute(() => window.__lodestoryLifecycleTest.showLayoutContent("project-management.files"));
      await $('[data-project-tree-path="正文.txt"]').waitForExist({timeout: 10000});
      assert.equal(await $('[data-project-tree-path="不可用.md"]').isExisting(), false);
      assert.equal(await $('[data-project-tree-path="旧格式.lode"]').isExisting(), false);
      const editor = await $('[aria-label="纯文本正文"]');
      await editor.waitForDisplayed({timeout: 10000});
      const updated = "新建文稿默认使用 TXT。";
      await editor.setValue(updated);

      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openDocument("不可用.md")), false);
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openDocument("旧格式.lode")), false);

      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
      assert.equal(await readFile(path.join(directory, "正文.txt"), "utf8"), updated);
      assert.equal(await readFile(path.join(directory, "不可用.md"), "utf8"), markdownSource);
      assert.equal(await readFile(path.join(directory, "旧格式.lode"), "utf8"), richTextSource);
    } finally {
      await browser.execute(() => window.__lodestoryLifecycleTest?.closeProject()).catch(() => {});
      await rm(parent, {recursive: true, force: true});
    }
  });
});
