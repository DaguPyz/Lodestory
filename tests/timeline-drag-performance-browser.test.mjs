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

function bounded(promise, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
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

function send(socket, pending, method, params = {}, sessionId) {
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

const frameTicks = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

test("timeline canvas virtualizes dense events and preserves real drag, zoom, editing, and lifecycle behavior", async t => {
  const configuredExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (configuredExecutable) throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    t.skip(`Chrome is not installed at ${executablePath}; browser-level timeline performance checks were not run.`);
    return;
  }

  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-timeline-drag-"));
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
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, {once: true});
      socket.addEventListener("error", reject, {once: true});
    }), "CDP websocket connection");
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
      configFile: false, root: process.cwd(), appType: "mpa",
      cacheDir: path.join(profile, "vite-cache"),
      server: {host: "127.0.0.1", port: 0, strictPort: true, hmr: false}, logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const target = await send(socket, pending, "Target.createTarget", {url: "about:blank"});
    const attachment = await send(socket, pending, "Target.attachToTarget", {targetId: target.targetId, flatten: true});
    const sessionId = attachment.sessionId;
    const cdp = (method, params = {}) => send(socket, pending, method, params, sessionId);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/timeline-drag-performance.html`});
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? "unknown browser exception"}`);
      return result.result.value;
    };
    const fixture = (method, ...args) => evaluate(`window.__timelineDragFixture.${method}(...${JSON.stringify(args)})`);
    const mouse = (type, x, y, {button = "none", buttons = 0, modifiers = 0, deltaX, deltaY, clickCount} = {}) => cdp("Input.dispatchMouseEvent", {
      type, x, y, button, buttons, modifiers,
      ...(type === "mouseWheel" ? {deltaX: deltaX ?? 0, deltaY: deltaY ?? 0}
        : {...(deltaX === undefined ? {} : {deltaX}), ...(deltaY === undefined ? {} : {deltaY})}),
      ...(clickCount === undefined ? {} : {clickCount}),
    });
    const press = (x, y, button = "left", clickCount = 0) => mouse("mousePressed", x, y,
      {button, buttons: button === "middle" ? 4 : 1, clickCount});
    const move = (x, y, button = "none") => mouse("mouseMoved", x, y,
      {button, buttons: button === "middle" ? 4 : button === "left" ? 1 : 0});
    const release = (x, y, button = "left", clickCount = 0) => mouse("mouseReleased", x, y,
      {button, buttons: 0, clickCount});
    const clickAt = async (x, y) => {
      await press(x, y, "left", 1);
      await release(x, y, "left", 1);
    };
    const clickSelector = async selector => {
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      assert.ok(point, `An element matching ${selector} is available for pointer input.`);
      await clickAt(point.x, point.y);
    };
    const clickButtonNamed = async text => {
      const point = await evaluate(`(() => {
        const node = [...document.querySelectorAll('button')]
          .find(item => item.textContent.includes(${JSON.stringify(text)}));
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      assert.ok(point, `The '${text}' button is available for pointer input.`);
      await clickAt(point.x, point.y);
    };
    const eventDialogState = () => evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('.ui-dialog')];
      const editor = dialogs.find(node => ['编辑事件', '添加时间线事件']
        .includes(node.querySelector('.ui-dialog-title')?.textContent.trim()));
      if (!editor) return {found: false, open: false, dialogs: dialogs.map(node => ({
        title: node.querySelector('.ui-dialog-title')?.textContent.trim() ?? null,
        inert: node.inert, ending: node.hasAttribute('data-ending-style'),
        starting: node.hasAttribute('data-starting-style'), opacity: getComputedStyle(node).opacity,
      }))};
      const rect = editor.getBoundingClientRect();
      return {found: true, open: !editor.inert && !editor.hasAttribute('data-ending-style')
        && !editor.hasAttribute('data-starting-style') && getComputedStyle(editor).opacity === '1'
        && rect.width > 0 && rect.height > 0,
        title: editor.querySelector('.ui-dialog-title')?.textContent.trim(), inert: editor.inert,
        ending: editor.hasAttribute('data-ending-style'), starting: editor.hasAttribute('data-starting-style'),
        opacity: getComputedStyle(editor).opacity, rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        dialogs: dialogs.map(node => ({title: node.querySelector('.ui-dialog-title')?.textContent.trim() ?? null,
          inert: node.inert, ending: node.hasAttribute('data-ending-style'),
          starting: node.hasAttribute('data-starting-style'), opacity: getComputedStyle(node).opacity}))};
    })()`);
    const dialogVisible = async () => (await eventDialogState()).open;
    const waitForFrame = () => evaluate(frameTicks);
    const view = () => fixture("state").then(({center, zoom}) => ({center, zoom}));
    const endpointPoint = async title => evaluate(`(() => {
      const node = [...document.querySelectorAll('.timeline-event-endpoint')]
        .find(item => item.getAttribute('aria-label')?.includes(${JSON.stringify(title)}));
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        hidden: node.getAttribute('aria-hidden') === 'true'};
    })()`);
    const openEventFromEndpoint = async (title, message) => {
      const point = await endpointPoint(title);
      assert.ok(point && !point.hidden, `The '${title}' endpoint is visibly available for pointer input.`);
      await clickAt(point.x, point.y);
      assert.equal((await eventDialogState()).found, false, "a single click does not open the event editor");
      assert.equal(await evaluate("Boolean(document.querySelector('.timeline-focus-assets'))"), false,
        "the first click of a double click does not enter asset focus");
      await press(point.x, point.y, "left", 2);
      await release(point.x, point.y, "left", 2);
      try { await waitFor(dialogVisible, message, 8000); }
      catch (cause) {
        const diagnostic = await evaluate(`(() => {
          const x = ${point.x}; const y = ${point.y};
          const hit = document.elementFromPoint(x, y);
          const describe = node => node && ({tag: node.tagName, className: typeof node.className === 'string'
            ? node.className : node.className?.baseVal, role: node.getAttribute('role'),
            ariaLabel: node.getAttribute('aria-label'), text: node.textContent?.trim().slice(0, 80)});
          const endpoint = [...document.querySelectorAll('.timeline-event-endpoint')]
            .find(node => node.getAttribute('aria-label')?.includes(${JSON.stringify(title)}));
          return {clickPoint: {x, y}, hit: describe(hit), active: describe(document.activeElement),
            overlayActive: document.querySelector('.timeline-events-overlay')?.dataset.active ?? null,
            canvasActive: document.querySelector('.canvas-surface')?.dataset.canvasActive ?? null,
            endpoint: endpoint && {ariaLabel: endpoint.getAttribute('aria-label'),
              ariaDisabled: endpoint.getAttribute('aria-disabled'), tabIndex: endpoint.getAttribute('tabindex')},
            view: window.__timelineDragFixture.state()};
        })()`);
        throw new Error(`${message} ${cause instanceof Error ? cause.message : cause}; click diagnostic: ${JSON.stringify(diagnostic)}; dialog state: ${JSON.stringify(await eventDialogState())}`);
      }
    };
    const waitForDialogClose = () => waitFor(async () => !(await eventDialogState()).found,
      "The event dialog did not leave the document after closing.");

    await waitFor(() => evaluate(`Boolean(window.__timelineDragFixture
      && document.querySelector('.timeline-canvas-frame')
      && document.querySelector('.timeline-events-overlay .timeline-event-labels')
      && document.querySelector('.timeline-axis-svg')?.getAttribute('width') === '1200')`),
    "The real timeline canvas did not finish its initial render.");
    await waitForFrame();

    await t.test("grows the axis, ticks, labels, then branches in order with bounded animation work", async () => {
      await fixture("setAnimationEvents", true);
      await waitForFrame();
      const lineAnimations = () => evaluate("document.querySelector('.timeline-axis-line').getAnimations().length");
      await fixture("open", "first");
      await waitFor(async () => await lineAnimations() === 1, "The axis growth animation did not start.");
      const animation = await evaluate(`(() => {
        const line = document.querySelector('.timeline-axis-line');
        const growth = line.getAnimations()[0];
        growth.pause(); growth.currentTime = 0;
        const start = getComputedStyle(line).transform;
        growth.currentTime = 200;
        const tickClip = document.querySelector('.timeline-axis-svg clipPath[id$="-ticks"] rect');
        const tickClips = [...document.querySelectorAll('.timeline-axis-svg clipPath[id$="-ticks"] rect')];
        const ticksGrowth = tickClip.getAnimations()[0];
        ticksGrowth.pause(); ticksGrowth.currentTime = 0;
        const ticksStart = getComputedStyle(tickClip).transform;
        ticksGrowth.currentTime = 525;
        const labelClip = document.querySelector('.timeline-axis-svg clipPath[id$="-labels"] rect');
        const labelClips = [...document.querySelectorAll('.timeline-axis-svg clipPath[id$="-labels"] rect')];
        const labelGrowth = labelClip.getAnimations()[0];
        labelGrowth.pause(); labelGrowth.currentTime = 1100;
        const labelsStart = getComputedStyle(labelClip).transform;
        labelGrowth.currentTime = 1225;
        const segments = [...document.querySelectorAll('.timeline-event-stems-growth line')];
        const first = segments[0];
        const last = segments.at(-1);
        const branch = first.getAnimations()[0];
        const lastBranch = last.getAnimations()[0];
        branch.pause(); branch.currentTime = branch.effect.getTiming().delay;
        const branchStart = getComputedStyle(first).strokeDashoffset;
        branch.currentTime += branch.effect.getTiming().duration / 2;
        const detail = document.querySelector('.timeline-event-details [data-growth-event]');
        const appearance = detail.getAnimations()[0];
        appearance.pause();
        appearance.currentTime = appearance.effect.getTiming().delay;
        const detailStart = getComputedStyle(detail).opacity;
        appearance.currentTime += 100;
        const description = document.querySelector('.timeline-event-summary');
        const titleAnimation = description.closest('.timeline-event-label').getAnimations()[0];
        const descriptionAnimation = description.getAnimations()[0];
        titleAnimation.pause(); descriptionAnimation.pause();
        descriptionAnimation.currentTime = titleAnimation.effect.getTiming().delay + 200;
        const descriptionBeforeTitle = getComputedStyle(description).opacity;
        descriptionAnimation.currentTime = descriptionAnimation.effect.getTiming().delay + 200;
        return {duration: growth.effect.getTiming().duration, start, middle: getComputedStyle(line).transform,
          ticksStart, ticksMiddle: getComputedStyle(tickClip).transform, ticksTiming: ticksGrowth.effect.getTiming(),
          ticksOrigin: getComputedStyle(tickClip).transformOrigin,
          labelsStart, labelsMiddle: getComputedStyle(labelClip).transform, labelsTiming: labelGrowth.effect.getTiming(),
          lastTickTiming: tickClips.at(-1).getAnimations()[0].effect.getTiming(),
          lastLabelTiming: labelClips.at(-1).getAnimations()[0].effect.getTiming(),
          axisClipCount: tickClips.length + labelClips.length,
          branchStart, branchMiddle: getComputedStyle(first).strokeDashoffset,
          branchTiming: branch.effect.getTiming(), lastDelay: lastBranch.effect.getTiming().delay,
          above: segments.some(item => Number(item.getAttribute('y2')) < Number(item.getAttribute('y1'))),
          below: segments.some(item => Number(item.getAttribute('y2')) > Number(item.getAttribute('y1'))),
          eventMasks: document.querySelectorAll('.timeline-events-svg mask, .timeline-events-svg clipPath').length,
          detailStart, detailMiddle: getComputedStyle(detail).opacity, detailTiming: appearance.effect.getTiming(),
          titleTiming: titleAnimation.effect.getTiming(), descriptionTiming: descriptionAnimation.effect.getTiming(),
          descriptionBeforeTitle, descriptionMiddle: getComputedStyle(description).opacity,
          segments: segments.length, otherAnimations: document.querySelector('.timeline-events-overlay').getAnimations({subtree: true}).length};
      })()`);
      assert.equal(animation.duration, 400);
      assert.notEqual(animation.start, animation.middle);
      assert.equal(animation.ticksTiming.delay, 400, "ticks start after the main axis");
      assert.equal(animation.ticksTiming.duration, 250);
      assert.equal(animation.lastTickTiming.delay + animation.lastTickTiming.duration, 1100, "all ticks complete before labels begin");
      assert.match(animation.ticksOrigin, /378px/, "ticks grow from their lower edge upwards");
      assert.notEqual(animation.ticksStart, animation.ticksMiddle, "ticks grow vertically");
      assert.equal(animation.labelsTiming.delay, 1100, "labels start after all ticks");
      assert.equal(animation.lastLabelTiming.delay + animation.lastLabelTiming.duration, 1600, "all labels complete before branches begin");
      assert.ok(animation.axisClipCount <= 48, "axis animation work stays bounded");
      assert.notEqual(animation.labelsStart, animation.labelsMiddle, "labels are revealed after the ticks");
      assert.ok(animation.segments > 0 && animation.segments <= 128, "branch animations remain bounded");
      assert.equal(animation.eventMasks, 0, "event leaders use no SVG mask or animated clip");
      assert.ok(animation.otherAnimations <= 280, "event animations are bounded");
      assert.ok(animation.branchTiming.delay >= 1600, "branches start after the labels finish");
      assert.ok(animation.lastDelay > animation.branchTiming.delay, "branches grow from left to right");
      assert.ok(animation.above && animation.below, "leaders grow in both directions away from the axis");
      assert.notEqual(animation.branchStart, animation.branchMiddle, "each branch segment is drawn progressively");
      assert.equal(animation.detailTiming.duration, 200, "endpoints fade in");
      assert.equal(animation.titleTiming.duration, 400, "titles fade in more slowly");
      assert.equal(animation.descriptionTiming.duration, 400, "descriptions fade in more slowly");
      assert.ok(animation.detailTiming.delay >= 2000, "details appear after their branch begins growing");
      assert.equal(Number(animation.detailStart), 0);
      assert.ok(Number(animation.detailMiddle) > 0 && Number(animation.detailMiddle) < 1, "node appearance has an intermediate opacity");
      assert.equal(animation.descriptionTiming.delay, animation.titleTiming.delay + animation.titleTiming.duration,
        "description waits until its title has appeared");
      assert.equal(Number(animation.descriptionBeforeTitle), 0);
      assert.ok(Number(animation.descriptionMiddle) > 0 && Number(animation.descriptionMiddle) < 1,
        "description fades in after the title");
      await evaluate("document.querySelector('.timeline-canvas-frame').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))");
      assert.equal(await lineAnimations(), 0);
      assert.equal(await evaluate("document.querySelector('.timeline-axis-svg clipPath')"), null, "interrupting removes the tick clip");
      assert.equal(await evaluate("Boolean(document.querySelector('.timeline-event-stems-growth'))"), false, "interrupting removes temporary leaders");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.timeline-event-stems')).visibility"), "visible", "the completed leaders remain visible");
      assert.equal(await evaluate("document.querySelector('.timeline-events-overlay').getAnimations({subtree:true}).length"), 0);
      await fixture("open", "first");
      await waitForFrame();
      assert.equal(await lineAnimations(), 0, "rendering the same open does not replay growth");

      await fixture("open", "second");
      await waitFor(async () => await lineAnimations() === 1, "A new open did not start growth.");
      await evaluate("document.documentElement.dataset.uiMotion = 'reduce'");
      await waitFor(async () => await lineAnimations() === 0, "Reducing motion did not stop growth.");
      await fixture("open", "third");
      await waitForFrame();
      assert.equal(await lineAnimations(), 0, "application reduced motion skips growth");
      await evaluate("delete document.documentElement.dataset.uiMotion");
      await cdp("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
      await fixture("open", "fourth");
      await waitForFrame();
      assert.equal(await lineAnimations(), 0, "system reduced motion skips growth");
      await cdp("Emulation.setEmulatedMedia", {features: []});
      await fixture("setAnimationEvents", false);
      await waitForFrame();
      await fixture("open", "dense-fallback");
      await waitForFrame();
      assert.equal(await lineAnimations(), 0, "extremely dense leaders fall back to a static view");
    });

    await t.test("keeps offscreen labels out of the DOM while retaining visible axis anchors", async () => {
      const result = await evaluate(`(() => {
        const frame = document.querySelector('.timeline-canvas-frame').getBoundingClientRect();
        const titleExists = title => [...document.querySelectorAll('.timeline-event-title')]
          .some(item => item.textContent === title);
        const axisAnchors = [...document.querySelectorAll('.timeline-event-axis-marker circle')].map(marker => {
          const rect = marker.getBoundingClientRect();
          return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        });
        return {width: frame.width, height: frame.height,
          labels: document.querySelectorAll('.timeline-event-label').length,
          markerGroups: document.querySelectorAll('.timeline-event-markers').length,
          firstDenseLabel: titleExists('Dense 0000'),
          horizontalOffscreenLabel: titleExists('Sparse beyond 2048'),
          verticalOffscreenLabel: titleExists('Dense 0998'),
          visibleAxisAnchorCount: axisAnchors.filter(point => point.y >= frame.top && point.y <= frame.bottom
            && point.x >= frame.left && point.x <= frame.right && Math.abs(point.y - (frame.top + frame.height / 2)) < 2).length};
      })()`);
      assert.equal(result.width, 1200);
      assert.equal(result.height, 720);
      assert.equal(result.firstDenseLabel, true, "a nearby dense event keeps its label");
      assert.equal(result.horizontalOffscreenLabel, false, "a horizontally offscreen event has no label node");
      assert.equal(result.verticalOffscreenLabel, false, "a vertically offscreen label has no DOM node");
      assert.ok(result.visibleAxisAnchorCount > 0, "visible axis anchors remain at the timeline axis when their endpoints are outside");
      assert.ok(result.labels < 250, `only nearby labels are mounted (${result.labels} of 11,000 events)`);
      console.log("timeline initial render diagnostics", JSON.stringify({
        elapsedSinceFixtureMs: await evaluate("performance.now() - window.__timelineDragReadyAt"),
        labels: result.labels, axisMarkerGroups: result.markerGroups,
      }));
    });

    await t.test("paints the axis at screen resolution across 25–400% zoom and keeps events aligned during a 400% drag", async () => {
      for (const zoom of [0.25, 1, 4]) {
        await fixture("setView", {x: 0, y: 0}, zoom);
        await waitForFrame();
        const axis = await evaluate(`(() => {
          const svg = document.querySelector('.timeline-axis-svg');
          const frame = document.querySelector('.timeline-canvas-frame').getBoundingClientRect();
          const matrix = svg.getScreenCTM();
          const origin = svg.querySelector('.timeline-axis-tick-origin').getBoundingClientRect();
          const caption = svg.querySelector('.timeline-axis-origin-caption');
          return {width: svg.getAttribute('width'), height: svg.getAttribute('height'),
            viewBox: svg.getAttribute('viewBox'), matrix: {a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d},
            originHeight: origin.height, captionFontSize: getComputedStyle(caption).fontSize,
            normalStrokeWidth: getComputedStyle(svg.querySelector('.timeline-axis-line')).strokeWidth,
            labels: [...svg.querySelectorAll('.timeline-axis-label')].map(label => {
              const bounds = label.getBoundingClientRect();
              const tick = svg.querySelector('.timeline-axis-tick[data-axis-tick-key="' + label.parentElement.dataset.axisTickKey + '"]').getBoundingClientRect();
              return {value: Number(label.textContent), fontSize: getComputedStyle(label).fontSize,
                x: bounds.left + bounds.width / 2 - frame.left, y: tick.top - frame.top,
                tickX: tick.left - frame.left};
            })};
        })()`);
        assert.equal(axis.width, '1200', `${zoom}: SVG keeps full screen width`);
        assert.equal(axis.height, '720', `${zoom}: SVG keeps full screen height`);
        assert.equal(axis.viewBox, '0 0 1200 720');
        assert.ok(Math.abs(axis.matrix.a - 1) < 1e-8 && Math.abs(axis.matrix.d - 1) < 1e-8
          && Math.abs(axis.matrix.b) < 1e-8 && Math.abs(axis.matrix.c) < 1e-8,
        `${zoom}: SVG paints at its intrinsic resolution`);
        assert.equal(axis.originHeight, 16, `${zoom}: origin tick keeps its screen length`);
        assert.equal(axis.captionFontSize, '11px');
        assert.equal(axis.normalStrokeWidth, '1px');
        assert.ok(axis.labels.length > 1);
        for (const label of axis.labels) {
          assert.equal(label.fontSize, '14px', `${zoom}: axis text is never painted at a shrunken font size`);
          const expectedX = 600 + label.value * 160 * zoom;
          assert.ok(Math.abs(label.x - expectedX) < 0.1 && Math.abs(label.tickX - expectedX) < 0.1,
            `${zoom}: label ${label.value} and its tick retain the same world-coordinate anchor`);
          assert.ok(Math.abs(label.y - 360) < 0.1);
        }
      }

      const blank = await evaluate(`(() => {
        for (const [x, y] of [[30, 40], [30, 100], [1170, 680], [30, 680]]) {
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest('.canvas-surface')
            && !hit.closest('input,textarea,select,button,a,[contenteditable],[data-canvas-interactive]')) return {x, y};
        }
        return null;
      })()`);
      assert.ok(blank, 'a blank point is available for real pointer dragging');
      await press(blank.x, blank.y, 'middle');
      await move(blank.x + 40, blank.y + 20, 'middle');
      await release(blank.x + 40, blank.y + 20, 'middle');
      await waitForFrame();
      assert.deepEqual(await view(), {center: {x: -10, y: -5}, zoom: 4});
      const alignment = await evaluate(`(() => {
        const tick = document.querySelector('.timeline-axis-tick-origin').getBoundingClientRect();
        const label = document.querySelector('.timeline-axis-label-origin').getBoundingClientRect();
        const anchors = [...document.querySelectorAll('.timeline-event-axis-marker circle')].map(marker => {
          const rect = marker.getBoundingClientRect();
          return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        });
        return {tickX: tick.left, tickY: tick.top, labelX: label.left + label.width / 2,
          hasAlignedAnchor: anchors.some(point => Math.abs(point.x - 640) < 0.1 && Math.abs(point.y - 380) < 0.1)};
      })()`);
      assert.ok(Math.abs(alignment.tickX - 640) < 0.1 && Math.abs(alignment.tickY - 380) < 0.1
        && Math.abs(alignment.labelX - 640) < 0.1 && alignment.hasAlignedAnchor,
      'axis strokes, text and event anchor move together in screen pixels at 400%');
      await fixture('setView', {x: 0, y: 0}, 1);
      await waitForFrame();
    });

    await t.test("applies real middle/space drags and wheel input exactly, including the final pointerup position", async () => {
      await press(100, 300, "middle");
      await move(137, 317, "middle");
      await release(158, 326, "middle");
      await waitForFrame();
      let current = await view();
      assert.deepEqual(current.center, {x: -58, y: -26}, "middle drag sums every screen-space movement");

      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      await press(100, 300, "left");
      await move(180, 285, "left");
      await release(180, 285, "left");
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      await waitForFrame();
      current = await view();
      assert.deepEqual(current.center, {x: -138, y: -11}, "space plus left drag pans by the exact pointer delta");

      await mouse("mouseWheel", 400, 280, {deltaX: 24, deltaY: -36});
      await waitForFrame();
      current = await view();
      assert.deepEqual(current.center, {x: -114, y: -47}, "ordinary wheel pans with the correct sign and distance");

      const anchor = {x: 30, y: 40};
      const zoomHit = await evaluate(`(() => {
        const target = document.elementFromPoint(${anchor.x}, ${anchor.y});
        return {tag: target?.tagName ?? null,
          className: typeof target?.className === 'string' ? target.className : target?.className?.baseVal ?? null,
          interactive: Boolean(target?.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[data-canvas-interactive]'))};
      })()`);
      assert.equal(zoomHit.interactive, false,
        `zoom cursor is over blank canvas rather than an interactive label/control (${JSON.stringify(zoomHit)})`);
      const beforeZoom = await view();
      const worldAnchor = {
        x: beforeZoom.center.x + (anchor.x - 600) / beforeZoom.zoom,
        y: beforeZoom.center.y + (anchor.y - 360) / beforeZoom.zoom,
      };
      await mouse("mouseWheel", anchor.x, anchor.y, {modifiers: 2, deltaY: -100});
      await waitForFrame();
      const afterZoom = await view();
      const anchoredWorldAfter = {
        x: afterZoom.center.x + (anchor.x - 600) / afterZoom.zoom,
        y: afterZoom.center.y + (anchor.y - 360) / afterZoom.zoom,
      };
      assert.ok(Math.abs(afterZoom.zoom - beforeZoom.zoom * Math.exp(0.2)) < 1e-10,
        `Ctrl-wheel applies its exponential zoom factor (${JSON.stringify({beforeZoom, afterZoom})})`);
      assert.ok(Math.abs(anchoredWorldAfter.x - worldAnchor.x) < 1e-8
        && Math.abs(anchoredWorldAfter.y - worldAnchor.y) < 1e-8, "zoom keeps the world point under the cursor fixed");
      await clickButtonNamed("回到原点");
      await waitForFrame();
      assert.deepEqual(await view(), {center: {x: 0, y: 0}, zoom: 1}, "the Home control returns to the original view");
    });

    await t.test("reveals an out-of-view endpoint, edits an event after index 2048, and preserves opaque asset IDs", async () => {
      await fixture("setView", {x: 4320, y: 320}, 1);
      await waitForFrame();
      const before = await fixture("state");
      assert.ok(before.targetIndex > 2048, "the target is beyond the former layout limit");
      assert.equal(before.eventCount, 11000);
      assert.deepEqual(before.target.assetIds, ["20000000-0000-4000-8000-000000000099"]);
      const offscreen = await endpointPoint("Sparse beyond 2048");
      assert.equal(offscreen, null, "the out-of-view endpoint is not mounted");
      assert.equal(await evaluate(`![...document.querySelectorAll('.timeline-event-title')]
        .some(item => item.textContent === 'Sparse beyond 2048')`), true,
      "the fully offscreen event label is not mounted");
      const anchor = await evaluate(`(() => {
        const circles = [...document.querySelectorAll('.timeline-event-axis-marker circle')];
        const frame = document.querySelector('.timeline-canvas-frame').getBoundingClientRect();
        const points = circles.map(circle => {
          const rect = circle.getBoundingClientRect();
          return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        });
        const nearest = points.sort((left, right) => Math.hypot(left.x - (frame.left + 600), left.y - (frame.top + 40))
          - Math.hypot(right.x - (frame.left + 600), right.y - (frame.top + 40)))[0];
        return {x: nearest?.x, y: nearest?.y,
          distance: nearest ? Math.hypot(nearest.x - (frame.left + 600), nearest.y - (frame.top + 40)) : Infinity,
          inFrame: nearest && nearest.x >= frame.left && nearest.x <= frame.right
            && nearest.y >= frame.top && nearest.y <= frame.bottom};
      })()`);
      assert.equal(anchor?.inFrame, true, "the event's axis anchor remains visible while its endpoint is outside");
      assert.ok(anchor.distance < 2, "the retained anchor stays at the target event's x position on the axis");

      await press(120, 180, "middle");
      await move(120, 340, "middle");
      await move(120, 500, "middle");
      await release(120, 500, "middle");
      await waitForFrame();
      const endpoint = await endpointPoint("Sparse beyond 2048");
      assert.ok(endpoint, "a vertical pan reveals the previously hidden endpoint");
      assert.equal(await evaluate(`Boolean([...document.querySelectorAll('.timeline-event-title')]
        .find(item => item.textContent === 'Sparse beyond 2048'))`), true,
      "the now-visible sparse event after index 2048 mounts a label");
      await openEventFromEndpoint("Sparse beyond 2048", "The visible endpoint did not open its event editor.");

      const titleInput = await evaluate(`(() => {
        const input = document.querySelector('.timeline-event-form input[type="text"]');
        if (!input) return null;
        const rect = input.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      assert.ok(titleInput, "the event title input is available in the editor");
      await clickAt(titleInput.x, titleInput.y);
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35});
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Home", code: "Home",
        windowsVirtualKeyCode: 36, modifiers: 8});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Home", code: "Home",
        windowsVirtualKeyCode: 36, modifiers: 8});
      const selection = await evaluate(`(() => {
        const input = document.querySelector('.timeline-event-form input[type="text"]');
        return {start: input?.selectionStart, end: input?.selectionEnd, length: input?.value.length};
      })()`);
      assert.deepEqual(selection, {start: 0, end: selection.length, length: selection.length},
        "Home and Shift+End select the title through real keyboard input");
      await cdp("Input.insertText", {text: "Edited sparse beyond 2048"});
      assert.equal(await evaluate(`document.querySelector('.timeline-event-form input[type="text"]')?.value`),
        "Edited sparse beyond 2048", "keyboard input edits the event through the real form");
      await clickSelector(".timeline-event-form button[type=submit]");
      await waitFor(() => fixture("saveCount").then(count => count === 1), "The edited event was not saved.");
      await waitForDialogClose();
      let saved = await fixture("state");
      assert.equal(saved.target.title, "Edited sparse beyond 2048");
      assert.deepEqual(saved.target.assetIds, ["20000000-0000-4000-8000-000000000099"],
        "editing preserves opaque asset IDs");

      await openEventFromEndpoint("Edited sparse beyond 2048", "The saved event could not be reopened.");
      const cancelPoint = await evaluate(`(() => {
        const button = [...document.querySelectorAll('.timeline-event-form button')]
          .find(item => item.textContent.trim() === '取消');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      assert.ok(cancelPoint, "the event editor exposes its cancel control");
      await clickAt(cancelPoint.x, cancelPoint.y);
      await waitForDialogClose();
      saved = await fixture("state");
      assert.equal(saved.saves, 1, "canceling the second edit does not save");
      assert.equal(saved.target.title, "Edited sparse beyond 2048", "cancel keeps the stored event unchanged");
      assert.deepEqual(saved.target.assetIds, ["20000000-0000-4000-8000-000000000099"]);
    });

    await t.test("the event context menu opens assets while single clicks leave the timeline in place", async () => {
      await fixture("setView", {x: 4320, y: 0}, 1);
      await fixture("setFocusAssets", true);
      await waitForFrame();
      const before = await fixture("state");
      const point = await endpointPoint(before.target.title);
      assert.ok(point);
      const openAssetsAt = async target => {
        await press(target.x, target.y, "right", 1);
        await release(target.x, target.y, "right", 1);
        const menuPoint = await waitFor(() => evaluate(`(() => {
          const item = [...document.querySelectorAll('.context-menu-item')]
            .find(node => node.textContent.trim() === '查看关联资产');
          if (!item) return null;
          const rect = item.getBoundingClientRect();
          return rect.width && rect.height ? {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2} : null;
        })()`), "the event menu did not offer related assets");
        assert.equal(await evaluate("Boolean(document.querySelector('.timeline-focus-assets'))"), false,
          "opening the context menu alone does not enter asset focus");
        await clickAt(menuPoint.x, menuPoint.y);
        await waitForFrame();
      };
      const focus = () => evaluate(`(() => {
        const item = document.querySelector('.timeline-focus-event');
        const scene = document.querySelector('.timeline-focus-scene');
        const groups = [...document.querySelectorAll('.timeline-focus-group')];
        const assets = [...document.querySelectorAll('.timeline-focus-asset')];
        const nodes = assets.map(asset => asset.querySelector('.timeline-focus-asset-node'));
        const delays = nodes.map(node => parseFloat(getComputedStyle(node).animationDelay));
        const sceneBox = scene?.getBoundingClientRect();
        const x = sceneBox?.left + sceneBox?.width * 0.5;
        const y = sceneBox?.top + sceneBox?.height * 0.5;
        const points = assets.map(asset => {
          const rect = asset.getBoundingClientRect();
          return [rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y];
        });
        const firstAngle = Math.atan2(points[0]?.[0], -points[0]?.[1]);
        const center = item?.getBoundingClientRect();
        return {assets: assets.map(asset => asset.querySelector('.timeline-focus-asset-name').textContent),
          groups: groups.map(group => group.getAttribute('aria-label')),
          pagination: Boolean(document.querySelector('.timeline-focus-pagination')),
          legends: document.querySelectorAll('.timeline-focus-group-heading').length,
          rings: document.querySelectorAll('.timeline-focus-orbit').length,
          centered: center && Math.abs(center.left + center.width / 2 - x) < 2 && Math.abs(center.top + center.height / 2 - y) < 2,
          orbit: Boolean(document.querySelector('.timeline-focus-orbit')),
          points, angles: points.map(([dx, dy]) => (Math.atan2(dx, -dy) - firstAngle + 2 * Math.PI) % (2 * Math.PI)),
          delays, animations: nodes.map(node => getComputedStyle(node).animationName),
          circles: nodes.every(node => {
            const {width, height, borderRadius} = getComputedStyle(node);
            return width === height && parseFloat(width) <= 80 && borderRadius === '50%';
          }),
          dots: new Set(groups.map(group => getComputedStyle(group.querySelector('.timeline-focus-asset-dot')).backgroundColor)).size,
          labels: getComputedStyle(document.querySelector('.timeline-event-labels')).opacity,
          axis: getComputedStyle(document.querySelector('.timeline-axis-overlay')).display,
          stems: getComputedStyle(document.querySelector('.timeline-event-stems')).display};
      })()`);
      await clickAt(point.x, point.y);
      assert.deepEqual((await focus()).assets, [], "a single click on the endpoint leaves asset focus closed");
      const otherTargets = await evaluate(`(() => {
        const id = window.__timelineDragFixture.targetId();
        return ['.timeline-event-label[data-timeline-event-id="' + id + '"] .timeline-event-title',
          '.timeline-event-axis-marker[data-timeline-event-id="' + id + '"]'].map(selector => {
            const node = document.querySelector(selector); if (!node) return null;
            const rect = node.getBoundingClientRect();
            return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
          }).filter(Boolean);
      })()`);
      assert.equal(otherTargets.length, 2);
      for (const target of otherTargets) {
        await clickAt(target.x, target.y);
        assert.deepEqual((await focus()).assets, [], "single clicking the title or axis marker does not enter asset focus");
      }
      assert.equal((await eventDialogState()).found, false);
      assert.notEqual((await focus()).axis, "none");
      await press(24, 160, "right", 1);
      await release(24, 160, "right", 1);
      await waitFor(() => evaluate("Boolean(document.querySelector('.context-menu-popup'))"), "the canvas menu did not open");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.context-menu-item')].map(item => item.textContent.trim())"),
        ["添加事件"], "the asset action is available only for an event");
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      await waitFor(() => evaluate("!document.querySelector('.context-menu-popup')"), "the canvas menu did not close");
      await openAssetsAt(point);
      const shown = await focus();
      assert.deepEqual(shown.assets, ["林舟", "陈师傅", "方晴", "闻溪", "守溪会", "造钟行", "旧街", "渡口"]);
      assert.deepEqual(shown.groups, ["人物", "势力", "地点"]);
      assert.equal(shown.legends, 0, "the category legend is removed");
      assert.ok(shown.centered && shown.orbit && shown.circles);
      assert.equal(shown.dots, 3);
      assert.equal(shown.labels, "0");
      assert.equal(shown.axis, "none");
      assert.equal(shown.stems, "none");
      const radii = shown.points.map(([x, y]) => Math.hypot(x, y));
      assert.ok(radii.every(radius => Math.abs(radius - radii[0]) < 1), "assets share a circular orbit around the event");
      assert.ok(radii[0] > 200 && radii[0] < 280, "the orbit stays compact");
      assert.ok(shown.angles.slice(1).every((angle, index) => angle > shown.angles[index]), "the cards occupy clockwise positions");
      assert.deepEqual(shown.delays, [0, 0.065, 0.13, 0.195, 0.26, 0.325, 0.39, 0.455]);
      const movement = await evaluate("(() => {"
        + "const node = document.querySelectorAll('.timeline-focus-asset-node')[2];"
        + "const animation = node.getAnimations()[0];"
        + "const delay = animation.effect.getTiming().delay;"
        + "animation.pause(); animation.currentTime = delay;"
        + "const box = node.getBoundingClientRect(); const start = box.x + box.width / 2;"
        + "animation.finish();"
        + "const end = node.getBoundingClientRect(); return end.x + end.width / 2 - start;"
        + "})()");
      assert.ok(movement > 200, "assets travel all the way from the event center");
      assert.equal((await eventDialogState()).found, false);

      const floating = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.timeline-focus-asset-node')];
        const event = document.querySelector('.timeline-focus-event');
        const before = event.getBoundingClientRect().toJSON();
        const samples = nodes.map(node => {
          const entry = node.getAnimations().find(animation => animation.animationName === 'timeline-focus-asset-reveal');
          entry?.finish();
          const drift = node.getAnimations().find(animation => animation.animationName === 'timeline-focus-asset-drift');
          if (!drift) return null;
          const timing = drift.effect.getTiming();
          drift.pause();
          const read = progress => {
            drift.currentTime = timing.delay + timing.duration * progress;
            const anchor = node.parentElement.getBoundingClientRect();
            const bounds = node.getBoundingClientRect();
            const dot = node.querySelector('.timeline-focus-asset-dot').getBoundingClientRect();
            const viewport = document.querySelector('.timeline-focus-viewport').getBoundingClientRect();
            return {x: bounds.left - anchor.left, y: bounds.top - anchor.top,
              inside: Math.min(bounds.left, dot.left) >= viewport.left && Math.min(bounds.top, dot.top) >= viewport.top
                && Math.max(bounds.right, dot.right) <= viewport.right && Math.max(bounds.bottom, dot.bottom) <= viewport.bottom};
          };
          const first = read(0.25), second = read(0.75);
          return {first, second, duration: timing.duration, iterations: timing.iterations === Infinity,
            translate: getComputedStyle(node).translate};
        });
        const after = event.getBoundingClientRect().toJSON();
        return {samples, eventStable: before.x === after.x && before.y === after.y};
      })()`);
      assert.equal(floating.samples.length, 8);
      assert.ok(floating.samples.every(sample => sample?.iterations), "every circular asset keeps floating after entry");
      assert.ok(new Set(floating.samples.map(sample => sample.duration)).size > 1, "the nodes do not all move in sync");
      assert.ok(floating.eventStable, "the central event stays still");
      for (const sample of floating.samples) {
        for (const position of [sample.first, sample.second]) {
          assert.ok(Math.abs(position.x) >= 2 && Math.abs(position.x) <= 5.1);
          assert.ok(Math.abs(position.y) >= 3 && Math.abs(position.y) <= 5.1);
          assert.ok(position.inside, "floating circles and their category dots are not clipped at the viewport edge");
        }
        assert.ok(sample.first.x * sample.second.x < 0 && sample.first.y * sample.second.y < 0,
          "the motion moves both left/right and up/down relative to the node's own position");
      }

      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      assert.equal(await evaluate("document.querySelector('.timeline-focus-assets')?.inert"), true,
        "the returning scene stops accepting input immediately");
      assert.equal((await focus()).axis, "none", "the timeline waits until assets return to the center");
      const dismissing = await evaluate(`([...document.querySelectorAll('.timeline-focus-asset-node')].map(node => {
        const animations = node.getAnimations();
        return {translate: animations[0]?.effect.getKeyframes()[0].translate,
          finite: animations.every(animation => animation.effect.getTiming().iterations !== Infinity)};
      }))`);
      assert.deepEqual(dismissing.map(sample => sample.translate), floating.samples.map(sample => sample.translate),
        "closing continues from the current floating position without a jump");
      assert.ok(dismissing.every(sample => sample.finite), "idle loops are canceled before closing");
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-assets')"), "the radial scene did not finish closing");
      assert.deepEqual((await focus()).assets, []);
      assert.notEqual((await focus()).axis, "none");
      assert.deepEqual(await fixture("state"), before, "entering and exiting focus does not save or move the timeline");

      await openAssetsAt(point);
      const interrupted = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.timeline-focus-asset-node')];
        for (const node of nodes) {
          const animation = node.getAnimations()[0];
          animation.pause(); animation.currentTime = animation.effect.getTiming().delay + 100;
        }
        return nodes.map(node => getComputedStyle(node).transform);
      })()`);
      await clickButtonNamed("返回时间线");
      const reversed = await evaluate(`([...document.querySelectorAll('.timeline-focus-asset-node')]
        .map(node => node.getAnimations()[0]?.effect.getKeyframes()[0].transform))`);
      assert.deepEqual(reversed, interrupted, "closing mid-entry starts from each asset's visible position");
      await fixture("open", "focus-interrupted");
      await waitForFrame();
      assert.deepEqual((await focus()).assets, [], "switching timelines clears a closing scene immediately");
      await openAssetsAt(point);
      await evaluate("new Promise(resolve => setTimeout(resolve, 500))");
      assert.equal((await focus()).assets.length, 8, "an old exit callback cannot dismiss a new focus scene");
      await clickButtonNamed("返回时间线");
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-assets')"), "the reopened scene did not close");

      await cdp("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
      await openAssetsAt(point);
      assert.deepEqual((await focus()).animations, Array(8).fill("none"));
      await clickAt(24, 160);
      assert.deepEqual((await focus()).assets, []);

      assert.equal(await evaluate(`(() => {
        const target = [...document.querySelectorAll('.timeline-event-endpoint')]
          .find(endpoint => endpoint.closest('[data-timeline-event-id]').dataset.timelineEventId === window.__timelineDragFixture.targetId());
        target?.focus();
        return document.activeElement === target;
      })()`), true);
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      assert.equal(await evaluate("document.activeElement.className"), "timeline-focus-event-title");
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r"});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13});
      await waitFor(dialogVisible, "Enter did not open the editor from the centered event", 5000);
      await clickButtonNamed("取消");
      await waitForDialogClose();
      assert.deepEqual((await focus()).assets, shown.assets);
      await clickButtonNamed("返回时间线");

      await fixture("setFocusAssets", true, 5);
      await waitForFrame();
      await openAssetsAt(point);
      const allThirteen = await focus();
      assert.equal(allThirteen.assets.length, 13, "all thirteen assets appear together");
      assert.equal(allThirteen.pagination, false, "there are no pagination controls");
      assert.equal(allThirteen.rings, 1, "thirteen assets fit around the event on one ring");
      assert.deepEqual(allThirteen.assets.slice(8), Array(5).fill("资产不可用"), "missing associations are still represented");

      await fixture("setFocusAssets", true, 32);
      await waitForFrame();
      const expanded = await focus();
      assert.equal(expanded.assets.length, 40, "larger asset sets are not truncated");
      assert.ok(expanded.rings > 1, "additional assets occupy outer rings");
      assert.ok(expanded.circles, "outer rings retain readable node sizes");
      for (let i = 0; i < expanded.points.length; i++) {
        for (let j = i + 1; j < expanded.points.length; j++) {
          const [x, y] = expanded.points[i];
          const [otherX, otherY] = expanded.points[j];
          assert.ok(Math.hypot(x - otherX, y - otherY) >= 90, "circles on the same or different rings do not overlap");
        }
      }
      const scrollBefore = await evaluate("document.querySelector('.timeline-focus-viewport').scrollTop");
      const viewBeforeScroll = await fixture("state");
      await mouse("mouseWheel", 500, 150, {deltaY: 180, deltaX: 0});
      await waitFor(() => evaluate(`document.querySelector('.timeline-focus-viewport')?.scrollTop > ${scrollBefore}`),
        "outer rings cannot be reached by scrolling");
      assert.deepEqual(await fixture("state"), viewBeforeScroll, "scrolling the asset diagram does not move the timeline or dismiss focus");
      await fixture("setActive", false);
      await waitForFrame();
      assert.deepEqual((await focus()).assets, [], "the focused view closes when the timeline is deactivated");
      await fixture("setActive", true);
      await waitForFrame();
      assert.notEqual((await focus()).axis, "none", "reactivating the timeline restores the axis");
      await evaluate(`(() => {
        for (const node of document.querySelectorAll('.fixture-host, .timeline-canvas-frame')) node.style.width = '450px';
      })()`);
      await waitFor(() => evaluate("document.querySelector('.timeline-events-overlay').offsetWidth === 450"), "the canvas did not resize");
      const narrowPoint = await endpointPoint(before.target.title);
      await openAssetsAt(narrowPoint);
      assert.equal((await focus()).orbit, false);
      assert.deepEqual((await focus()).groups, ["人物", "势力", "地点", "失效关联"]);
      assert.equal((await focus()).assets.length, 40, "narrow windows also retain all associations without pagination");
      assert.equal((await focus()).pagination, false);
      assert.equal(await evaluate(`(() => { const region = document.querySelector('.timeline-focus-groups');
        return region.scrollHeight > region.clientHeight && region.scrollWidth <= region.clientWidth; })()`), true,
        "all assets remain reachable in the narrow scrolling list");
      await clickButtonNamed("返回时间线");
      await evaluate(`(() => {
        for (const node of document.querySelectorAll('.fixture-host, .timeline-canvas-frame')) node.style.width = '';
      })()`);
      await waitFor(() => evaluate("document.querySelector('.timeline-events-overlay').offsetWidth === 1200"), "the canvas did not regain its size");
      await cdp("Emulation.setEmulatedMedia", {features: []});
      await fixture("setFocusAssets", false);
    });

    await t.test("stops pending drags when disabled, when the viewport changes, and on unmount", async () => {
      await fixture("setView", {x: 0, y: 0}, 1);
      await fixture("setActive", true);
      await waitForFrame();

      await press(200, 300, "middle");
      await move(240, 320, "middle");
      await fixture("setActive", false);
      await waitForFrame();
      const disabledState = await fixture("state");
      assert.equal(await evaluate(`document.querySelector('.canvas-surface')?.dataset.canvasDragging`), "false");
      await move(280, 360, "middle");
      await release(280, 360, "middle");
      await waitForFrame();
      assert.deepEqual((await fixture("state")).center, disabledState.center,
        "no queued drag movement applies after the surface is disabled");

      await fixture("setActive", true);
      await waitForFrame();
      await press(200, 300, "middle");
      await move(230, 310, "middle");
      const oldIndex = await fixture("replaceViewport");
      await waitForFrame();
      const oldState = await fixture("oldViewportState", oldIndex);
      const newState = await fixture("state");
      await move(270, 330, "middle");
      await release(270, 330, "middle");
      await waitForFrame();
      assert.deepEqual(await fixture("oldViewportState", oldIndex), oldState,
        "a replaced viewport receives no stale drag update");
      assert.deepEqual((await fixture("state")).center, newState.center,
        "the new viewport does not inherit the previous drag");

      await press(200, 300, "middle");
      await move(220, 315, "middle");
      const beforeUnmount = await fixture("state");
      await fixture("unmount");
      await waitForFrame();
      await move(260, 350, "middle");
      await release(260, 350, "middle");
      await waitForFrame();
      assert.deepEqual((await fixture("state")).center, beforeUnmount.center,
        "unmount releases the surface before old frame work can pan the viewport");
    });

    await waitForFrame();
    assert.deepEqual(pageErrors, [], "the browser reports no timeline canvas exceptions");
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await bounded(new Promise(resolve => chrome.once("exit", resolve)), "Chrome shutdown").catch(() => {});
    }
    if (server) await bounded(server.close(), "Vite server shutdown").catch(() => {});
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
