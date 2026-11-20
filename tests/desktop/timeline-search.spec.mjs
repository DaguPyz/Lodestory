import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

describe("Timeline event search", () => {
  it("centers the event endpoint and outlines only the current search match", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-timeline-search-"));
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 10000});
      const project = await browser.execute(async parentPath => {
        const {project} = await window.__TAURI__.core.invoke("create_project", {parentPath, name: "事件定位"});
        return project;
      }, parent);
      const lists = path.join(project.path, ".lodestory/outline-design/timelines");
      const events = path.join(project.path, ".lodestory/timeline/events");
      await mkdir(lists, {recursive: true});
      await mkdir(events, {recursive: true});
      const first = {id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "群山以北"};
      const second = {id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "渡口以南"};
      const firstTarget = {id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002", title: "远山烽火", offset: 5000,
        placement: "above", summary: "山脊上的夜火", important: true, assetIds: []};
      const neighbor = {...firstTarget, id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", title: "同日的前一件事"};
      const secondTarget = {id: "dddddddd-dddd-4ddd-8ddd-000000000001", title: "渡口回信", offset: -3000,
        placement: "below", summary: "从渡船带回的回信", important: false, assetIds: []};
      const stored = [];
      for (const [timeline, points] of [[first, [neighbor, firstTarget]], [second, [secondTarget]]]) {
        const date = "2026-10-23T12:00:00Z";
        await writeFile(path.join(lists, `${timeline.id}.json`), JSON.stringify({
          format: "lodestory.timeline-list-entry", schemaVersion: 1, ...timeline, summary: "", createdAt: date, updatedAt: date,
        }));
        const file = path.join(events, `${timeline.id}.json`);
        const content = JSON.stringify({format: "lodestory.timeline-events", schemaVersion: 2, timelineId: timeline.id, events: points});
        await writeFile(file, content);
        stored.push({file, content});
      }
      assert.equal(await browser.execute(project => window.__lodestoryLifecycleTest.openPreparedProject(project), project), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        return !!state.session && state.active && !state.busy && !state.loading;
      }), {timeout: 10000});
      await browser.execute(() => window.__lodestoryLifecycleTest.focusWindow());
      await browser.execute(() => window.__lodestoryLifecycleTest.showLayoutContent("body-editor.main"));

      async function openSearchResult(title) {
        const toolbar = await $('button[aria-label="搜索项目"]');
        await toolbar.waitForClickable({timeout: 5000});
        await toolbar.click();
        const query = await $('input[aria-label="搜索项目资源"]');
        await query.waitForDisplayed({timeout: 5000});
        await query.setValue(title);
        const result = await $(`//button[span[contains(@class, 'project-search-title') and normalize-space(.)='${title}']]`);
        await result.waitForDisplayed({timeout: 10000});
        await result.click();
        await query.waitForDisplayed({timeout: 5000, reverse: true});
      }

      async function locate(timeline, target, zoom) {
        await openSearchResult(target.title);
        let position;
        await browser.waitUntil(async () => {
          position = await browser.execute((title, eventId) => {
            const surface = document.querySelector(`.timeline-canvas-frame > .canvas-surface[aria-label="${title}时间轴"]`);
            const dot = surface?.querySelector(`[data-timeline-event-id="${eventId}"] .timeline-event-endpoint-dot`);
            if (!dot || !surface.clientWidth || !surface.clientHeight || surface.querySelector('[data-event-focused="true"]')) return null;
            const canvas = surface.getBoundingClientRect();
            const point = dot.getBoundingClientRect();
            const marks = [...surface.querySelectorAll(".timeline-event-search-match")];
            const [mark] = marks;
            const outline = mark && getComputedStyle(mark);
            const isMatch = marks.length === 1 && mark.closest(".timeline-event-label")?.dataset.timelineEventId === eventId;
            return {x: (point.left + point.right - canvas.left - canvas.right) / 2,
              y: (point.top + point.bottom - canvas.top - canvas.bottom) / 2, zoom: Number(surface.dataset.canvasZoom),
              highlighted: isMatch && outline.outlineStyle === "solid" && outline.outlineWidth === "1px",
              announced: dot.closest("[role=button]")?.getAttribute("aria-description")?.includes("当前搜索命中")};
          }, timeline.title, target.id);
          return !!position && Math.abs(position.x) <= 1 && Math.abs(position.y) <= 1 && position.highlighted && position.announced;
        }, {timeout: 5000, timeoutMsg: `The event ${target.title} was not centered and outlined.`});
        assert.equal(position.zoom, zoom);
      }

      await locate(first, firstTarget, 1);
      await $('button[aria-label="放大画布"]').click();
      await browser.execute(() => {
        const surface = document.querySelector('.timeline-canvas-frame > .canvas-surface');
        surface.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
      });
      await locate(first, firstTarget, 1.25);
      await browser.execute(eventId => {
        const endpoint = document.querySelector(`[data-timeline-event-id="${eventId}"] .timeline-event-endpoint`);
        endpoint.dispatchEvent(new KeyboardEvent("keydown", {key: " ", bubbles: true}));
      }, firstTarget.id);
      await $('.timeline-events-overlay[data-event-focused="true"]').waitForExist({timeout: 5000});
      await locate(first, firstTarget, 1.25);
      await locate(first, neighbor, 1.25);
      await locate(second, secondTarget, 1);
      await openSearchResult(first.title);
      await $('.timeline-canvas-frame > .canvas-surface[aria-label="群山以北时间轴"]').waitForDisplayed({timeout: 5000});
      assert.equal(await $(".timeline-event-search-match").isExisting(), false);
      assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
      for (const {file, content} of stored) assert.equal(await readFile(file, "utf8"), content);
    } finally {
      await browser.execute(() => window.__lodestoryLifecycleTest?.closeProject()).catch(() => {});
      await rm(parent, {recursive: true, force: true});
    }
  });
});
