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

    await t.test("scales event text in place while keeping ruler text fixed", async () => {
      const zoomSwitch = 'button[role="switch"]';
      const checked = () => evaluate(`document.querySelector(${JSON.stringify(zoomSwitch)}).getAttribute('aria-checked')`);
      const textLayout = () => evaluate(`(() => {
        const selectors = ['.timeline-axis-label-origin', '.timeline-axis-origin-caption', '.timeline-event-offset',
          '.timeline-event-title', '.timeline-event-summary', '.timeline-event-turning-caption'];
        const fontSizes = selectors.map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize));
        const rulerLabels = [...document.querySelectorAll('.timeline-axis-label')].map(label => ({
          value: label.textContent, x: label.getAttribute('x'), fontSize: getComputedStyle(label).fontSize,
        }));
        return {fontSizes, rulerLabels,
          toggleSize: getComputedStyle(document.querySelector('button[role="switch"]')).fontSize};
      })()`);
      await fixture("setZoomEvents", true);
      assert.equal(await checked(), "false", "the switch is off by default");
      let previousRulerValues;
      for (const zoom of [0.25, 1, 4]) {
        await fixture("setView", {x: 8, y: 56}, zoom);
        await waitForFrame();
        const before = await view();
        const fixed = await textLayout();
        assert.deepEqual(fixed.fontSizes, [14, 11, 13, 20, 14, 12]);
        const rulerValues = fixed.rulerLabels.map(label => label.value);
        assert.ok(fixed.rulerLabels.every(label => label.fontSize === "14px"));
        if (previousRulerValues) assert.notDeepEqual(rulerValues, previousRulerValues, "zoom recalculates the displayed tick values");
        previousRulerValues = rulerValues;
        await clickSelector(zoomSwitch);
        assert.equal(await checked(), "true");
        assert.deepEqual(await view(), before, "the switch leaves the canvas center and zoom in place");
        assert.deepEqual(await textLayout(), {
          ...fixed, fontSizes: fixed.fontSizes.map((size, index) => index < 2 ? size : size * zoom),
        }, "only event text changes size when the switch is enabled");
        if (zoom < 4) await clickSelector(zoomSwitch);
      }

      const savedView = await view();
      await fixture("swapCanvasView");
      await waitForFrame();
      assert.equal(await checked(), "false", "a different timeline view starts in the default mode");
      await fixture("swapCanvasView");
      await waitForFrame();
      assert.equal(await checked(), "true", "returning to a timeline restores its mode");
      assert.deepEqual(await view(), savedView);
      await evaluate(`document.querySelector(${JSON.stringify(zoomSwitch)}).focus()`);
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32});
      assert.equal(await checked(), "false", "Space toggles the focused switch");
      assert.deepEqual(await view(), savedView);
      await fixture("setZoomEvents", false);
      await fixture("setView", {x: 0, y: 0}, 1);
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
      const breadcrumbSelector = 'nav[aria-label="时间线浏览路径"]';
      const clickBreadcrumb = position => clickSelector(`${breadcrumbSelector} li:nth-child(${position}) button`);
      const backToTimeline = () => clickBreadcrumb(1);
      const backToEvent = () => clickBreadcrumb(2);
      const assertPath = async (...assets) => {
        const labels = ["时间线", before.target.title, ...assets];
        const crumbs = await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${breadcrumbSelector} li`)})].map(item => ({
          label: item.textContent.trim(), current: item.querySelector('[aria-current="page"]') !== null,
          clickable: item.querySelector('button') !== null,
        }))`);
        assert.deepEqual(crumbs, labels.map((label, index) => ({
          label, current: index === labels.length - 1, clickable: index < labels.length - 1,
        })));
      };
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
      await assertPath();
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

      const assetCircle = () => evaluate(`(() => {
        const [node, neighbor] = document.querySelectorAll('.timeline-focus-asset-node');
        const face = node.querySelector('.timeline-focus-asset-face');
        const drift = item => item.getAnimations().find(animation => animation.animationName === 'timeline-focus-asset-drift');
        const {x, y, width, height} = node.getBoundingClientRect();
        return {x: x + width / 2, y: y + height / 2, width,
          scale: Number(getComputedStyle(face).scale), driftTime: drift(node)?.currentTime,
          neighborTime: drift(neighbor)?.currentTime, paused: drift(node)?.playState === 'paused',
          pressing: face.getAnimations().some(animation => animation.animationName === 'timeline-focus-asset-press')};
      })()`);
      const readyCircle = await waitFor(async () => {
        const circle = await assetCircle();
        return circle.neighborTime > 505 && circle;
      }, "The asset circles did not finish entering.");
      await move(readyCircle.x, readyCircle.y);
      const hovered = await waitFor(async () => {
        const circle = await assetCircle();
        return circle.scale > 1.05 && circle.paused && circle;
      }, "Hover should enlarge the asset circle and pause its drift.");
      await waitForFrame();
      const held = await assetCircle();
      assert.ok(Math.abs(held.width - readyCircle.width) < 0.01, "hover does not resize the hit area");
      assert.equal(held.driftTime, hovered.driftTime);
      assert.ok(held.neighborTime > hovered.neighborTime, "the neighboring circle keeps floating");

      await clickAt(held.x, held.y);
      const compressed = await evaluate(`(() => {
        const face = document.querySelector('.timeline-focus-asset-face');
        const press = face.getAnimations().find(animation => animation.animationName === 'timeline-focus-asset-press');
        if (!press) return null;
        press.currentTime = press.effect.getTiming().duration * 0.35;
        return Number(getComputedStyle(face).scale);
      })()`);
      assert.ok(compressed > 0 && compressed < 1, "click compresses the circle below its original size");
      await waitFor(async () => {
        const circle = await assetCircle();
        return circle.scale === 1 && !circle.pressing && circle.paused;
      }, "The circle should return to its original size while still hovered.");
      await move(24, 160);
      await waitFor(async () => {
        const circle = await assetCircle();
        return !circle.paused && circle.driftTime > held.driftTime;
      }, "The circle did not resume drifting after the pointer left.");

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
      await backToTimeline();
      const reversed = await evaluate(`([...document.querySelectorAll('.timeline-focus-asset-node')]
        .map(node => node.getAnimations()[0]?.effect.getKeyframes()[0].transform))`);
      assert.deepEqual(reversed, interrupted, "closing mid-entry starts from each asset's visible position");
      await fixture("open", "focus-interrupted");
      await waitForFrame();
      assert.deepEqual((await focus()).assets, [], "switching timelines clears a closing scene immediately");
      await openAssetsAt(point);
      await evaluate("new Promise(resolve => setTimeout(resolve, 500))");
      assert.equal((await focus()).assets.length, 8, "an old exit callback cannot dismiss a new focus scene");
      await backToTimeline();
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-assets')"), "the reopened scene did not close");

      await fixture("setFocusAssets", true, 0, 1);
      await fixture("showRelations", true);
      await openAssetsAt(point);
      const centerName = () => evaluate("document.querySelector('.timeline-focus-relation-name')?.textContent");
      const waitForAsset = name => waitFor(() => evaluate(`(() => {
        const node = document.querySelector('button[aria-label^="查看「${name}」的资产关系"]');
        return node && getComputedStyle(node).transform === 'none' && getComputedStyle(node).pointerEvents === 'auto';
      })()`), `Asset '${name}' did not become available.`);
      const clickAsset = async name => {
        await waitForAsset(name);
        await clickSelector(`button[aria-label^="查看「${name}」的资产关系"]`);
      };
      await clickAsset("林舟");
      assert.equal(await centerName(), "林舟");
      await assertPath("林舟");
      const graphCanvas = '.canvas-surface[aria-label="资产关系图"]';
      const graphPosition = () => evaluate(`(() => {
        const {x, y} = document.querySelector('.timeline-focus-scene').getBoundingClientRect();
        const breadcrumb = document.querySelector('.timeline-focus-breadcrumbs').getBoundingClientRect();
        return {x, y, breadcrumbX: breadcrumb.x, breadcrumbY: breadcrumb.y};
      })()`);
      const timelineBeforePan = await view();
      const graphBeforePan = await graphPosition();
      await clickAt(96, 204);
      await assertPath("林舟");
      await press(96, 204, "left", 1);
      await move(165, 238, "left");
      await waitForFrame();
      assert.deepEqual(await graphPosition(), {...graphBeforePan, x: graphBeforePan.x + 69, y: graphBeforePan.y + 34},
        "the relationship graph follows the pointer while the breadcrumb stays in place");
      await release(192, 263, "left", 1);
      assert.deepEqual(await graphPosition(), {...graphBeforePan, x: graphBeforePan.x + 96, y: graphBeforePan.y + 59},
        "releasing the pointer applies the final movement and keeps the graph open");
      await assertPath("林舟");
      assert.deepEqual(await view(), timelineBeforePan, "relationship panning leaves the timeline viewport untouched");
      await press(192, 263, "middle", 1);
      await move(169, 231, "middle");
      await release(169, 231, "middle", 1);
      assert.deepEqual(await graphPosition(), {...graphBeforePan, x: graphBeforePan.x + 73, y: graphBeforePan.y + 27},
        "middle-button drag pans the relationship graph too");
      await evaluate(`(() => {
        const surface = document.querySelector(${JSON.stringify(graphCanvas)});
        surface.focus({preventScroll: true});
        for (const key of ['ArrowRight', 'ArrowDown']) {
          for (let step = 0; step < 12; step++) surface.dispatchEvent(new KeyboardEvent('keydown', {key, shiftKey: true, bubbles: true}));
        }
      })()`);
      await waitForFrame();
      assert.deepEqual(await graphPosition(), {...graphBeforePan, x: graphBeforePan.x + 73 - 2880, y: graphBeforePan.y + 27 - 2880},
        "relationship panning continues beyond the diagram in both axes");
      assert.deepEqual(await evaluate(`(() => {
        const surface = document.querySelector(${JSON.stringify(graphCanvas)});
        const {overflowX, overflowY} = getComputedStyle(surface);
        return [overflowX, overflowY, surface.scrollLeft, surface.scrollTop];
      })()`), ["clip", "clip", 0, 0], "the relationship surface clips at the view without creating a scroll container");
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Home", code: "Home", windowsVirtualKeyCode: 36});
      assert.deepEqual(await graphPosition(), graphBeforePan, "Home centers the relationship graph");
      assert.equal(await evaluate("Boolean(document.querySelector('[role=toolbar][aria-label=画布视图]'))"), false,
        "timeline viewport controls are hidden while the graph owns the canvas");
      const mapping = await waitFor(() => evaluate(`(() => {
        const scene = document.querySelector('.timeline-focus-scene');
        const center = scene.querySelector('.timeline-focus-relation-center-node');
        const labels = [...scene.querySelectorAll('.timeline-focus-relation-label')];
        if (center.closest('.timeline-focus-relation-center-motion').getAnimations().length
          || labels.length !== 2 || labels.some(label => getComputedStyle(label.closest('.timeline-focus-relation-phase')).opacity !== '1'
          || getComputedStyle(label).visibility !== 'visible')) return null;
        const bounds = scene.getBoundingClientRect(), node = center.getBoundingClientRect();
        return {centered: Math.abs(node.x + node.width / 2 - bounds.x - bounds.width / 2) < 1
          && Math.abs(node.y + node.height / 2 - bounds.y - bounds.height / 2) < 1,
          lines: scene.querySelectorAll('.timeline-focus-relation-line').length,
          labels: labels.map(label => label.textContent),
          peers: [...scene.querySelectorAll('.timeline-focus-asset-name')].map(peer => peer.textContent)};
      })()`), "The saved relationships did not render as labeled connections.");
      assert.deepEqual(mapping, {centered: true, lines: 2, labels: ["师徒 / 传授功法", "死敌"], peers: ["陈师傅", "闻溪"]},
        "only saved neighbors appear around the centered asset, with one labeled line per peer");
      const graphToolbar = '[role="toolbar"][aria-label="关系图视图"]';
      const graphZoomState = () => evaluate(`(() => {
        const toolbar = document.querySelector(${JSON.stringify(graphToolbar)});
        const scene = document.querySelector('.timeline-focus-scene').getBoundingClientRect();
        const sizes = ['.timeline-focus-relation-name', '.timeline-focus-asset-name',
          '.timeline-focus-asset-type', '.timeline-focus-relation-label'].map(selector =>
          parseFloat(getComputedStyle(document.querySelector(selector)).fontSize));
        return {zoom: toolbar.querySelector('.canvas-zoom-value').textContent, sizes,
          checked: toolbar.querySelector('[role=switch]').getAttribute('aria-checked'),
          width: scene.width, x: scene.x + scene.width / 2, y: scene.y + scene.height / 2};
      })()`);
      const atOriginalZoom = await graphZoomState();
      assert.equal(atOriginalZoom.zoom, "100%");
      assert.equal(atOriginalZoom.checked, "false");
      await clickSelector(`${graphToolbar} button[aria-label="放大画布"]`);
      const at125 = await graphZoomState();
      assert.equal(at125.zoom, "125%");
      assert.equal(at125.width, atOriginalZoom.width * 1.25);
      assert.deepEqual(at125.sizes, atOriginalZoom.sizes, "default zoom keeps the graph text at its original size");
      await clickSelector(`${graphToolbar} [role="switch"]`);
      assert.deepEqual(await graphZoomState(), {
        ...at125, checked: "true", sizes: at125.sizes.map(size => size * 1.25),
      }, "switching modes scales graph labels in place");
      const pointer = await evaluate(`(() => {
        const node = document.querySelector('.timeline-focus-relation-center-node').getBoundingClientRect();
        return {x: Math.round(node.x + node.width * 0.67), y: Math.round(node.y + node.height * 0.4)};
      })()`);
      const wheelFactor = Math.exp(0.2);
      await mouse("mouseWheel", pointer.x, pointer.y, {deltaY: -100, modifiers: 2});
      await waitFor(async () => (await graphZoomState()).zoom === "153%", "Ctrl-wheel does not zoom the graph");
      const afterGraphWheel = await graphZoomState();
      assert.ok(Math.abs(afterGraphWheel.x - (pointer.x + (at125.x - pointer.x) * wheelFactor)) < 1
        && Math.abs(afterGraphWheel.y - (pointer.y + (at125.y - pointer.y) * wheelFactor)) < 1,
      "the point under the pointer stays anchored during graph zoom");
      await evaluate(`(() => {
        const scene = document.querySelector('.timeline-focus-scene');
        let changes = 0;
        const observer = new MutationObserver(records => { changes += records.length; });
        observer.observe(scene, {attributeFilter: ['data-scrolled']});
        window.__finishGraphZoom = () => {
          changes += observer.takeRecords().length;
          observer.disconnect();
          delete window.__finishGraphZoom;
          return changes;
        };
      })()`);
      await mouse("mouseWheel", pointer.x, pointer.y, {deltaY: -1200, modifiers: 2});
      await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(graphToolbar)})
        .querySelector('.canvas-zoom-value').textContent === '400%'`), "the graph does not reach its maximum zoom");
      const atMaximumZoom = await graphPosition();
      const maxZoomFactor = 4 / (1.25 * wheelFactor);
      const maxRadius = atOriginalZoom.width * 2;
      assert.ok(Math.abs(atMaximumZoom.x + maxRadius - (pointer.x + (afterGraphWheel.x - pointer.x) * maxZoomFactor)) < 1
        && Math.abs(atMaximumZoom.y + maxRadius - (pointer.y + (afterGraphWheel.y - pointer.y) * maxZoomFactor)) < 1,
      "cursor anchoring holds over the relationship node through large zoom changes");
      assert.equal(await evaluate("window.__finishGraphZoom()"), 0,
        "zoom keeps the anchored viewport throughout the update without falling back to the centered layout");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.timeline-focus-relation-name')).fontSize"), "64px");
      assert.ok(await evaluate("document.querySelector('.timeline-focus-relation-line').getAttribute('d').length > 0"),
        "connections remain visible even when their nodes leave the view");
      assert.deepEqual(await view(), timelineBeforePan, "graph zoom leaves the timeline viewport untouched");
      await clickSelector(`${graphToolbar} > button`);
      assert.deepEqual(await graphZoomState(), {...atOriginalZoom, checked: "true"}, "reset restores the graph center and zoom");
      const highlight = () => evaluate(`(() => {
        const center = document.querySelector('.timeline-focus-relation-center-node');
        const labels = [...document.querySelectorAll('.timeline-focus-relation-label, .timeline-focus-relation-list-label')];
        return {
          center: center.hasAttribute('data-highlighted'),
          peers: [...document.querySelectorAll('.timeline-focus-asset[data-highlighted] .timeline-focus-asset-name')].map(node => node.textContent),
          pressed: labels.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent),
          lineHighlighted: getComputedStyle(document.querySelector('.timeline-focus-relation-line[data-highlighted]')
            ?? center).strokeWidth === '2px',
        };
      })()`);
      const teacherLabel = 'button.timeline-focus-relation-label[aria-label^="师徒"]';
      const enemyLabel = 'button.timeline-focus-relation-label[aria-label^="死敌"]';
      await clickSelector(teacherLabel);
      assert.deepEqual(await highlight(), {center: true, peers: ["陈师傅"], pressed: ["师徒 / 传授功法"], lineHighlighted: true});
      assert.equal(await centerName(), "林舟", "selecting a label keeps the same center asset");
      await clickSelector(enemyLabel);
      assert.deepEqual(await highlight(), {center: true, peers: ["闻溪"], pressed: ["死敌"], lineHighlighted: true});
      await clickSelector(enemyLabel);
      assert.deepEqual(await highlight(), {center: false, peers: [], pressed: [], lineHighlighted: false});
      await evaluate(`document.querySelector(${JSON.stringify(teacherLabel)}).focus()`);
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r"});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13});
      assert.deepEqual(await highlight(), {center: true, peers: ["陈师傅"], pressed: ["师徒 / 传授功法"], lineHighlighted: true});
      await clickAsset("陈师傅");
      assert.equal(await centerName(), "陈师傅");
      assert.equal((await fixture("relationView", -2)).disposed, true, "switching center assets releases the old graph viewport");
      assert.equal((await graphZoomState()).checked, "true", "the zoom mode follows the graph while browsing its nodes");
      await assertPath("林舟", "陈师傅");
      assert.deepEqual(await highlight(), {center: false, peers: [], pressed: [], lineHighlighted: false});
      assert.deepEqual((await focus()).assets, ["林舟"], "the same relationship can be followed in either direction");
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      assert.equal(await centerName(), "林舟");
      await assertPath("林舟");
      await clickAsset("陈师傅");
      await clickAsset("林舟");
      await assertPath("林舟", "陈师傅", "林舟");
      await clickBreadcrumb(3);
      await assertPath("林舟");
      assert.equal(await centerName(), "林舟");
      await clickAsset("陈师傅");
      await backToEvent();
      await assertPath();
      assert.deepEqual((await focus()).assets, ["林舟"], "back restores the original event's associations");
      await fixture("setFocusAssets", true);
      await clickAsset("闻溪");
      assert.equal(await centerName(), "闻溪");
      assert.equal((await graphZoomState()).checked, "false", "a new graph browsing session opens in the default mode");
      await backToEvent();
      await clickAsset("方晴");
      assert.equal(await centerName(), "方晴");
      assert.equal(await evaluate("document.querySelector('.timeline-focus-relation-center [role=status]').textContent"), "暂无资产关系");
      await backToEvent();
      await fixture("setFocusAssets", true, 0, 1);
      await clickAsset("林舟");
      const filterTrigger = ".timeline-focus-filter > button";
      const filterModes = ".timeline-focus-filter-modes";
      const filterPopup = ".timeline-focus-filter-popup";
      const filterMode = label => `${filterModes} button[aria-label="${label}"]`;
      const filterLayers = () => evaluate(`({
        modes: Boolean(document.querySelector('${filterModes}[data-open]')),
        categories: Boolean(document.querySelector('${filterPopup}[data-open]')),
      })`);
      const openFilterModes = async () => {
        await clickSelector(filterTrigger);
        await waitFor(() => evaluate(`(() => {
          const modes = document.querySelector('${filterModes}[data-open]');
          return modes && getComputedStyle(modes).opacity === '1';
        })()`), "the filter mode transition did not finish");
      };
      const dismissFilterLayer = async () => {
        await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
        await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
      };
      await openFilterModes();
      await clickSelector(filterMode("排除"));
      assert.deepEqual(await filterLayers(), {modes: true, categories: true});
      await fixture("showRelations", false);
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-relation-center')"), "Removing the source should return to the event scene.");
      assert.equal((await fixture("relationView")).disposed, true, "removing the relation source releases the graph viewport");
      assert.equal(await evaluate(`Boolean(document.querySelector('${filterTrigger}, ${filterModes}, ${filterPopup}'))`), false,
        "removing the relation source also dismisses the category filter");
      await assertPath();
      assert.deepEqual((await focus()).assets, ["林舟"], "event assets remain visible without the optional relation source");
      assert.equal(await evaluate("document.querySelectorAll('button.timeline-focus-asset-node').length"), 0);
      await backToTimeline();
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-assets')"), "The event scene did not close.");

      await fixture("setDenseRelations", true);
      await fixture("showRelations", true);
      await openAssetsAt(point);
      await clickAsset("林舟");
      const relationEntry = await evaluate(`(() => {
        const scene = document.querySelector('.timeline-focus-scene');
        const {width, height, x, y} = scene.getBoundingClientRect();
        const port = scene.closest('.canvas-surface').getBoundingClientRect();
        const nodes = [...scene.querySelectorAll('.timeline-focus-asset-node')];
        const delays = nodes.flatMap(node => node.getAnimations().map(animation => animation.effect.getTiming().delay));
        return {
          ids: nodes.map(node => node.closest('[data-peer-id]').dataset.peerId),
          centered: Math.abs(x + width / 2 - port.x - port.width / 2) < 1
            && Math.abs(y + height / 2 - port.y - port.height / 2) < 1,
          pan: {x: (width - port.width) / 2, y: (height - port.height) / 2},
          phases: new Set(delays).size,
          fades: scene.querySelectorAll('.timeline-focus-relation-phase').length,
        };
      })()`);
      assert.ok(relationEntry.centered && relationEntry.ids.length < 127 && relationEntry.ids.length > 0,
        "the first screen mounts only nearby nodes in the full diagram");
      assert.equal(relationEntry.phases, 3, "the first screen spreads nodes across three start times");
      assert.equal(relationEntry.fades, 3, "each batch shares one line layer and one label fade");
      const {x: panX, y: panY} = relationEntry.pan;
      await fixture("panRelation", panX, panY);
      const outerLabel = await waitFor(() => evaluate(`(() => {
        const initial = new Set(${JSON.stringify(relationEntry.ids)});
        const labels = [...document.querySelectorAll('.timeline-focus-relation-label')];
        const label = labels.find(node => {
          if (initial.has(node.dataset.peerId)) return false;
          const r = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        });
        return label?.dataset.peerId;
      })()`), "No initially unmounted relationship was revealed by panning.");
      await clickSelector(`button.timeline-focus-relation-label[data-peer-id="${outerLabel}"]`);
      assert.equal(await evaluate(`document.querySelector('.timeline-focus-relation-label[aria-pressed=true]').dataset.peerId`), outerLabel);
      assert.ok((await highlight()).lineHighlighted, "a deferred relationship can be selected and draws a highlighted line");
      await evaluate(`document.querySelector('.timeline-focus-relation-label[aria-pressed=true]').focus({preventScroll: true})`);
      await fixture("panRelation", -panX, -panY);
      await waitFor(() => evaluate(`document.activeElement.dataset.peerId === "${outerLabel}"
        && document.querySelectorAll('.timeline-focus-asset[data-peer-id]').length >= ${relationEntry.ids.length}`),
        "Panning keeps the keyboard-focused outer label mounted.");
      await evaluate(`document.querySelector(${JSON.stringify(graphCanvas)}).focus({preventScroll: true})`);
      await waitFor(() => evaluate(`!document.querySelector('.timeline-focus-relation-label[data-peer-id="${outerLabel}"]')`),
        "Panning back culls the offscreen label.");
      await fixture("panRelation", panX, panY);
      await waitFor(() => evaluate(`document.querySelector('.timeline-focus-relation-label[aria-pressed=true]')?.dataset.peerId === "${outerLabel}"`),
        "Returning to the selected outer relationship restores its highlight.");
      await clickSelector(`${graphToolbar} > button`);
      await mouse("mouseWheel", 600, 352, {deltaY: 1200, modifiers: 2});
      await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(graphToolbar)})
        .querySelector('.canvas-zoom-value').textContent === '25%'`), "the graph does not reach its minimum zoom");
      const labelsAtMinimum = await evaluate(`({
        nodes: document.querySelectorAll('.timeline-focus-asset-node').length,
        labels: document.querySelectorAll('.timeline-focus-relation-label').length,
        descriptions: document.querySelectorAll('.timeline-focus-asset-node[aria-description]').length,
      })`);
      assert.ok(labelsAtMinimum.labels > 0 && labelsAtMinimum.labels < labelsAtMinimum.nodes && labelsAtMinimum.descriptions > 0,
        "dense zoom hides colliding labels and keeps their descriptions available from the nodes");
      const selectedMode = () => evaluate(`document.querySelector('${filterModes} [aria-pressed="true"]').getAttribute('aria-label')`);
      const filterEntry = () => evaluate(`(() => {
        const button = document.querySelector('${filterTrigger}');
        return {text: button.textContent, label: button.getAttribute('aria-label'), active: button.hasAttribute('data-filter-active')};
      })()`);
      const filterHint = () => evaluate(`document.querySelector('${filterPopup} .timeline-focus-filter-caption').textContent`);
      const graphStatus = () => evaluate("document.querySelector('.timeline-focus-relation-center [role=status]')?.textContent");
      const relationSegments = () => evaluate(`([...document.querySelectorAll('.timeline-focus-relation-line')])
        .reduce((segments, path) => segments + path.getAttribute('d').split('M').length - 1, 0)`);
      const category = id => `${filterPopup} input[type=checkbox][value="${id}"]`;
      const emptyFilter = "没有符合筛选条件的关联资产";
      await openFilterModes();
      assert.deepEqual(await filterLayers(), {modes: true, categories: false});
      assert.equal(await evaluate(`(() => {
        const modes = document.querySelector('${filterModes}').getBoundingClientRect();
        const trigger = document.querySelector('${filterTrigger}').getBoundingClientRect();
        const toolbar = document.querySelector('.timeline-focus-toolbar').getBoundingClientRect();
        const path = document.querySelector('.timeline-focus-breadcrumbs').getBoundingClientRect();
        const centerY = bounds => bounds.top + bounds.height / 2;
        return Math.abs(trigger.right - toolbar.right) < 1 && modes.right < trigger.left
          && Math.abs(centerY(modes) - centerY(trigger)) <= 2 && modes.left >= path.right - 0.5;
      })()`), true, "the mode icons share the trigger row and leave room for the breadcrumb path");
      assert.equal(await selectedMode(), "全部");
      assert.deepEqual(await filterEntry(), {text: "", label: "分类筛选", active: false});
      await clickSelector(filterMode("包含"));
      assert.deepEqual(await filterLayers(), {modes: true, categories: true});
      await waitForFrame();
      assert.equal(await evaluate(`(() => {
        const modes = document.querySelector('${filterModes}').getBoundingClientRect();
        const options = document.querySelector('${filterPopup}').getBoundingClientRect();
        return options.top >= modes.bottom && Math.abs(options.right - modes.right) < 1;
      })()`), true, "the category options open directly beneath the mode icons");
      assert.deepEqual(await filterEntry(), {text: "", label: "分类筛选，包含 0 类", active: true});
      assert.equal(await filterHint(), "勾选要显示的分类");
      assert.equal(await graphStatus(), emptyFilter);
      await clickSelector(category("person"));
      assert.equal(await filterHint(), "只显示所选分类");
      assert.deepEqual((await focus()).assets, ["陈师傅", "闻溪"]);
      assert.equal(await centerName(), "林舟");
      assert.equal(await relationSegments(), 2);

      await clickSelector(filterMode("排除"));
      assert.equal(await filterHint(), "隐藏所选分类");
      const places = (await focus()).assets;
      assert.ok(places.length > 0 && places.every(name => name.startsWith("外圈资产")));
      await clickSelector(category("place"));
      assert.equal(await graphStatus(), emptyFilter);
      assert.equal(await evaluate("document.querySelectorAll('.timeline-focus-relation-line, .timeline-focus-relation-label').length"), 0);
      await clickSelector(filterMode("全部"));
      assert.deepEqual(await filterLayers(), {modes: true, categories: false});
      assert.equal((await focus()).assets.length, labelsAtMinimum.nodes);

      await clickSelector(filterMode("包含"));
      await clickSelector(category("person"));
      await dismissFilterLayer();
      assert.deepEqual(await filterLayers(), {modes: true, categories: false});
      await dismissFilterLayer();
      assert.deepEqual(await filterLayers(), {modes: false, categories: false});
      assert.equal(await centerName(), "林舟", "Escape dismisses the filter popup first");
      await openFilterModes();
      assert.deepEqual(await filterLayers(), {modes: true, categories: false});
      assert.equal(await selectedMode(), "包含", "opening the modes again retains the category filter");
      await clickSelector(filterTrigger);
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-filter[data-modes-visible]')"),
        "the closed mode strip did not release its toolbar space");
      await mouse("mouseWheel", 600, 352, {deltaY: -1600, modifiers: 2});
      await waitFor(() => evaluate(`document.querySelector('${graphToolbar} .canvas-zoom-value').textContent === '400%'`),
        "the filtered graph did not zoom in");
      assert.equal(await relationSegments(), 2, "connections to filtered categories stay hidden at high zoom");
      await clickSelector(`${graphToolbar} > button`);
      await clickAsset("陈师傅");
      assert.deepEqual(await filterEntry(), {text: "", label: "分类筛选", active: false},
        "the new center starts with all categories");
      await fixture("setDenseRelations", false);
      await backToTimeline();
      await waitFor(() => evaluate("!document.querySelector('.timeline-focus-assets')"), "The large graph did not close.");
      assert.deepEqual(await view(), timelineBeforePan, "the breadcrumb returns to the timeline's original view");
      assert.equal(await evaluate("Boolean(document.querySelector('[role=toolbar][aria-label=画布视图]'))"), true);
      await fixture("showRelations", false);
      await fixture("setFocusAssets", true);

      await cdp("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
      await openAssetsAt(point);
      assert.deepEqual((await focus()).animations, Array(8).fill("none"));
      const staticCircle = await assetCircle();
      await move(staticCircle.x, staticCircle.y);
      await clickAt(staticCircle.x, staticCircle.y);
      assert.deepEqual(await assetCircle(), staticCircle, "reduced motion keeps the circles still under hover and click");
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
      await backToTimeline();

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
      await fixture("showRelations", true);
      await waitForAsset("林舟");
      await evaluate("document.querySelector('button.timeline-focus-asset-node').focus()");
      await cdp("Input.dispatchKeyEvent", {type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r"});
      await cdp("Input.dispatchKeyEvent", {type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13});
      assert.equal(await centerName(), "林舟");
      assert.equal(await evaluate("document.activeElement.className"), "timeline-focus-relation-name");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.timeline-focus-relation-list-label')].map(node => node.textContent)"),
        ["师徒 / 传授功法", "死敌"], "the narrow view keeps the same relationship descriptions beside the assets");
      await clickSelector('button.timeline-focus-relation-list-label[aria-label^="师徒"]');
      assert.deepEqual(await highlight(), {center: true, peers: ["陈师傅"], pressed: ["师徒 / 传授功法"], lineHighlighted: false});
      await openFilterModes();
      await clickSelector(filterMode("排除"));
      await clickSelector(category("person"));
      assert.equal(await evaluate(`(() => {
        const options = document.querySelector('${filterPopup}').getBoundingClientRect();
        const frame = document.querySelector('.timeline-canvas-frame').getBoundingClientRect();
        return options.left >= frame.left && options.right <= frame.right;
      })()`), true, "the options panel fits within the narrow timeline");
      assert.equal(await graphStatus(), emptyFilter);
      assert.deepEqual((await focus()).assets, []);
      assert.equal((await highlight()).center, false, "filtering a category clears the hidden label's highlight in the list");
      await backToEvent();
      await backToTimeline();
      await fixture("showRelations", false);
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
