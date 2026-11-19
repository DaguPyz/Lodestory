import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

describe("TXT-only document editor", () => {
  it("centers and outlines the clicked project search occurrence in the manuscript", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-project-search-"));
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 10000});
      const project = await browser.execute(async parentPath => {
        const {project} = await window.__TAURI__.core.invoke("create_project", {parentPath, name: "正文搜索"});
        return project;
      }, parent);
      const term = "同一处关键线索";
      const lines = Array.from({length: 1100}, (_, i) => `第 ${i + 1} 行。${"这是会自动换行的正文。".repeat(i % 8)}`);
      lines[104] = `较早的${term}。`;
      lines[1038] = `较晚的${term}。`;
      const documentPath = path.join(project.path, "长篇.txt");
      const manuscript = lines.join("\r\n");
      await writeFile(documentPath, manuscript);
      await writeFile(path.join(project.path, "另一篇.txt"), "另一份文稿。");
      assert.equal(await browser.execute(project => window.__lodestoryLifecycleTest.openPreparedProject(project), project), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        return !!state.session && state.active && !state.busy && !state.loading;
      }), {timeout: 10000});
      await browser.execute(() => window.__lodestoryLifecycleTest.showLayoutContent("asset-management.assets"));

      async function openOccurrence(line, viewportWasHidden = false) {
        const search = await $('button[aria-label="搜索项目"]');
        await search.waitForClickable({timeout: 5000});
        await search.click();
        const query = await $('input[aria-label="搜索项目资源"]');
        await query.waitForDisplayed({timeout: 5000});
        await query.setValue(term);
        const result = await $(`//button[starts-with(normalize-space(.), "第 ${line} 行 ·")]`);
        await result.waitForDisplayed({timeout: 10000});
        await result.click();
        await query.waitForDisplayed({timeout: 5000, reverse: true});
        if (viewportWasHidden) {
          // Return the viewport after the selection reaches the editor but before it can scroll.
          await browser.waitUntil(() => browser.execute(term => {
            const input = document.querySelector('.editor-document[aria-label="长篇.txt"]:not([hidden]) .plain-text-input');
            return input?.value === `较早的${term}。` && input.value.slice(input.selectionStart, input.selectionEnd) === term;
          }, term), {timeout: 5000});
          await browser.execute(() => {
            document.querySelector('.editor-document[aria-label="长篇.txt"] .plain-text-viewport').style.display = "";
          });
        }
        let state;
        try {
          await browser.waitUntil(async () => {
            state = await browser.execute(line => {
              const viewport = document.querySelector('.editor-document[aria-label="长篇.txt"]:not([hidden]) .plain-text-viewport');
              const mark = viewport?.querySelector(`.plain-text-line[data-line="${line - 1}"] .plain-text-search-match`);
              const bounds = viewport?.getBoundingClientRect();
              const match = mark?.getBoundingClientRect();
              return {top: viewport?.scrollTop, text: mark?.textContent,
                centerDistance: match && Math.abs((match.top + match.bottom - bounds.top - bounds.bottom) / 2),
                visible: !!match && match.top >= bounds.top && match.bottom <= bounds.bottom,
                outline: mark && getComputedStyle(mark).outlineStyle,
                firstLine: viewport?.querySelector(".plain-text-line")?.getAttribute("data-line"),
                feedback: document.querySelector(".editor-document-feedback")?.textContent};
            }, line);
            return state.top > 0 && state.text === term && state.visible && state.centerDistance <= 6;
          }, {timeout: 5000});
        } catch (error) {
          throw new Error(`The clicked occurrence on line ${line} is not centered: ${JSON.stringify(state)}`, {cause: error});
        }
        assert.equal(state.outline, "solid");
      }

      await openOccurrence(1039);
      const closeTab = await $('button[aria-label="关闭 长篇.txt"]');
      await closeTab.click();
      await closeTab.waitForExist({timeout: 5000, reverse: true});
      await openOccurrence(1039);
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openDocument("另一篇.txt")), true);
      await browser.execute(() => {
        document.querySelector('.editor-document[aria-label="长篇.txt"] .plain-text-viewport').style.display = "none";
      });
      await openOccurrence(105, true);
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
      assert.equal(await readFile(documentPath, "utf8"), manuscript);
    } finally {
      await browser.execute(() => window.__lodestoryLifecycleTest?.closeProject()).catch(() => {});
      await rm(parent, {recursive: true, force: true});
    }
  });

  it("completes, finds and inspects project asset names in the packaged WebView", async () => {
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
      const assetId = (typeId, index) => `${typeId.slice(0, -2)}${typeId.at(-1)}${index}`;
      const field = (suffix, owner, title, order, valueType = "text", config = {}) => ({
        id: `00000000-0000-4000-8000-0000000000${suffix}`, owner, title, order, valueType, config, status: "active",
      });
      const role = field("30", {kind: "type", id: people}, "身份", 0);
      const post = field("31", {kind: "type", id: people}, "驻守地点", 1, "reference", {targetTypeId: places});
      const home = field("32", {kind: "type", id: people}, "籍贯", 2);
      const notes = field("40", {kind: "asset", id: assetId(people, 0)}, "巡逻手记", 0);
      const record = "暮色时检查城门与灯火。\n沿北墙巡视，记下经过的船只。\n交班时核对守夜名册。\n".repeat(5) + "交班后归还钥匙。";
      await writeFile(path.join(objects, "..", "templates.json"), JSON.stringify([
        {id: people, order: 0, name: "角色", status: "active", description: ""},
        {id: places, order: 1, name: "地点", status: "active", description: ""},
      ]));
      const templates = path.join(objects, "..", "templates");
      await mkdir(templates, {recursive: true});
      await writeFile(path.join(templates, `${people}.json`), JSON.stringify({fields: [role, post, home]}));
      for (const [typeId, names] of [[people, ["林川", "林月", "林月见"]], [places, ["林湾"]]]) {
        const assets = names.map((name, index) => name === "林川"
          ? {id: assetId(typeId, index), name, typeId, description: "白石城的守门人。暮色时换岗，负责城门的夜间巡逻。",
            color: "#ee7766", values: {[role.id]: "城门守卫", [post.id]: assetId(places, 0), [notes.id]: record}}
          : {id: assetId(typeId, index), name, typeId, description: "", values: {}});
        await writeFile(path.join(objects, `${typeId}.json`), JSON.stringify({assets, fields: typeId === people ? [notes] : []}));
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
        const asset = [...document.querySelectorAll(".plain-text-highlight")].find(element => element.textContent === "林川");
        const {x, y, width, height} = asset.getBoundingClientRect();
        for (const type of ["pointerdown", "pointerup"]) {
          asset.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 1, button: 0,
            metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), clientX: x + width / 2, clientY: y + height / 2}));
        }
      });
      const card = await $(".plain-text-highlight-card");
      await card.waitForDisplayed({timeout: 5000});
      assert.equal(await card.$("h2").getText(), "林川");
      assert.match(await card.$('[aria-label="资产简介"]').getText(), /^白石城的守门人/u);
      assert.equal(await card.$(".plain-text-highlight-card-category").isExisting(), false);
      await card.$('button[aria-label="展开详情"][aria-expanded="false"]').click();
      const collapse = await card.$('button[aria-label="收起详情"][aria-expanded="true"]');
      await collapse.waitForDisplayed({timeout: 5000});
      assert.equal(await card.$(".plain-text-highlight-card-category").getText(), "角色");
      assert.match(await card.$(".plain-text-highlight-card-description").getText(), /^白石城的守门人/u);
      const details = await browser.execute(() => {
        const body = document.querySelector('.plain-text-highlight-card-body[aria-label="卡片详情"]');
        const display = Array.from(body.querySelectorAll("dt"), term => [term.textContent, term.nextElementSibling.textContent]);
        const scrollable = body.scrollHeight > body.clientHeight;
        body.scrollTop = body.scrollHeight;
        const scrolled = body.scrollTop > 0;
        body.scrollTop = 0;
        return {display, scrollable, scrolled};
      });
      assert.deepEqual(Object.fromEntries(details.display), {颜色标记: "#EE7766", 身份: "城门守卫", 驻守地点: "林湾", 籍贯: "未填写", 巡逻手记: record});
      assert.equal(details.scrollable && details.scrolled, true);
      await collapse.click();
      await card.$('[aria-label="资产简介"]').waitForDisplayed({timeout: 5000});
      await card.$('button[aria-label="关闭卡片 林川"]').click();
      await card.waitForExist({timeout: 5000, reverse: true});

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
