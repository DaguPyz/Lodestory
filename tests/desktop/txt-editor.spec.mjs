import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

describe("TXT-only document editor", () => {
  it("completes and finds project asset names in the packaged WebView", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-completion-"));
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 10000});
      const project = await browser.execute(async parentPath => {
        const {project} = await window.__TAURI__.core.invoke("create_project", {parentPath, name: "白石城"});
        return project;
      }, parent);
      const objects = path.join(project.path, ".lodestory", "assets", "objects");
      await mkdir(objects, {recursive: true});
      const people = "00000000-0000-4000-8000-000000000001";
      const places = "00000000-0000-4000-8000-000000000002";
      await writeFile(path.join(objects, "..", "templates.json"), JSON.stringify([
        {id: people, order: 0, name: "角色", status: "active", description: ""},
        {id: places, order: 1, name: "地点", status: "active", description: ""},
      ]));
      for (const [typeId, names] of [[people, ["林川", "林月", "林月见"]], [places, ["林湾"]]]) {
        const assets = names.map((name, index) => ({id: `${typeId.slice(0, -2)}${typeId.at(-1)}${index}`,
          name, typeId, description: "", values: {}, ...(name === "林川" ? {color: "#ee7766"} : {})}));
        await writeFile(path.join(objects, `${typeId}.json`), JSON.stringify({assets, fields: []}));
      }
      const manuscript = "第七章  回城\n\n暮色漫过白石城的城墙，晚钟响了三下。\n\n林川从林湾归来，守门人翻开名册。\n她低声念道：「";
      const documentPath = path.join(project.path, "回城.txt");
      await writeFile(documentPath, manuscript);
      assert.equal(await browser.execute(project => window.__lodestoryLifecycleTest.openPreparedProject(project), project), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        if (state.loading?.error) throw new Error(state.loading.error.message);
        return !!state.session && !state.busy && !state.loading;
      }), {timeout: 10000});
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openDocument("回城.txt")), true);
      await $('textarea[aria-autocomplete="list"]').waitForExist({timeout: 10000});
      await browser.waitUntil(() => browser.execute(() => {
        const [person, place] = document.querySelectorAll(".plain-text-highlight");
        return person?.textContent === "林川" && getComputedStyle(person).color === "rgb(238, 119, 102)"
          && place?.textContent === "林湾" && !place.style.getPropertyValue("--plain-text-highlight-color")
          && getComputedStyle(place).color !== getComputedStyle(place.parentElement).color;
      }), {timeout: 5000, timeoutMsg: "The TXT editor did not use the stored asset color and the default accent."});
      await browser.execute(() => {
        const input = document.querySelector("textarea.plain-text-input");
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "f", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true}));
      });
      const query = await $('.plain-text-search input[aria-label="查找文本"]');
      await query.waitForDisplayed({timeout: 5000});
      await query.setValue("林川");
      const next = await $('.plain-text-search button[aria-label="下一个"]');
      assert.equal(await next.$("svg").isExisting(), true);
      await next.click();
      await browser.waitUntil(() => browser.execute(() => {
        const match = document.querySelector(".plain-text-search-match");
        return match?.textContent === "林川" && getComputedStyle(match).outlineStyle === "solid";
      }), {timeout: 5000, timeoutMsg: "The selected find result did not get an outline."});
      await $('.plain-text-search button[aria-label="关闭查找"]').click();
      await query.waitForDisplayed({timeout: 5000, reverse: true});
      assert.equal(await $(".plain-text-search-match").isExisting(), false);

      await browser.execute(() => {
        const input = document.querySelector("textarea.plain-text-input");
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "End", metaKey: true, ctrlKey: true, bubbles: true}));
        input.setRangeText("林", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new InputEvent("input", {data: "林", inputType: "insertText", bubbles: true}));
      });
      const popup = await $(".plain-text-completion:not([hidden])");
      await popup.waitForDisplayed({timeout: 10000});
      assert.deepEqual(await browser.execute(() => Array.from(document.querySelectorAll(".plain-text-completion-name"),
        node => node.textContent)), ["林川", "林月", "林月见", "林湾"]);
      await browser.keys("ArrowDown");
      await browser.keys("ArrowDown");
      if (process.env.LODESTORY_COMPLETION_PREVIEW_PATH) await browser.saveScreenshot(process.env.LODESTORY_COMPLETION_PREVIEW_PATH);
      await browser.keys("Escape");
      await browser.execute(() => {
        const input = document.querySelector("textarea.plain-text-input");
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "F10", shiftKey: true, bubbles: true, cancelable: true}));
      });
      const showCompletion = await $('//*[@role="menuitem" and normalize-space(.)="显示补全"]');
      await showCompletion.waitForDisplayed({timeout: 5000});
      await browser.execute(() => {
        Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(item => item.textContent.trim() === "显示补全").click();
      });
      try { await popup.waitForDisplayed({timeout: 5000}); }
      catch (error) {
        const state = await browser.execute(() => ({focus: document.activeElement?.className,
          menuOpen: !!document.querySelector(".context-menu-popup[data-open]"),
          prefix: document.querySelector("textarea.plain-text-input")?.value}));
        throw new Error(`Completion did not reopen after the context-menu action. ${JSON.stringify(state)}`, {cause: error});
      }
      await browser.execute(() => document.querySelector(".plain-text-completion-option:nth-child(2)").click());
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
      assert.equal(await readFile(documentPath, "utf8"), manuscript + "林月");
    } finally {
      await browser.execute(() => window.__lodestoryLifecycleTest?.closeProject()).catch(() => {});
      await rm(parent, {recursive: true, force: true});
    }
  });

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
