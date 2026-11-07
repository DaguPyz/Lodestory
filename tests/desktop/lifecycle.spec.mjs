import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

describe("plugin lifecycle in the desktop application", () => {
  it("preserves the real editor while unloading an unrelated plugin", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-plugin-stop-"));
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
      assert.equal(await browser.execute(path => window.__lodestoryLifecycleTest.openTemporaryProject(path), parent), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        return !!state.session && !state.busy && !state.loading;
      }), {timeout: 30000});
      await browser.execute(() => window.__lodestoryLifecycleTest.createDocument());
      const editor = await $('[aria-label="纯文本正文"]');
      await editor.waitForDisplayed({timeout: 30000});
      await editor.setValue("卸载插件时保留的正文");
      await browser.execute(() => {
        window.__editorBeforeStop = document.querySelector('[aria-label="纯文本正文"]');
        window.__rootBeforeStop = document.querySelector("#root").firstElementChild;
      });
      const editorStop = await browser.execute(() => window.__lodestoryLifecycleTest.tryUnloadEditor());
      assert.equal(editorStop.phase, "check");
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.hasWritingStatus()), true);
      await browser.execute(() => window.__lodestoryLifecycleTest.unloadWritingStatus());
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.hasWritingStatus()), false);
      await browser.execute(() => window.__lodestoryLifecycleTest.unloadTimeline());
      assert.equal(await browser.execute(() => window.__editorBeforeStop === document.querySelector('[aria-label="纯文本正文"]')), true);
      assert.equal(await browser.execute(() => window.__rootBeforeStop === document.querySelector("#root").firstElementChild), true);
      assert.equal(await editor.getValue(), "卸载插件时保留的正文");
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
      assert.equal(await readFile(path.join(parent, "生命周期测试", "正文.txt"), "utf8"), "卸载插件时保留的正文");
    } finally {
      await rm(parent, {recursive: true, force: true});
    }
  });
});
