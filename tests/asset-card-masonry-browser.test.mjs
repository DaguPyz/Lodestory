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

async function waitFor(action, message, timeoutMs = 15000) {
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

function sendCdpCommand(socket, pending, method, params = {}, sessionId) {
  const id = pending.nextId++;
  return new Promise((resolve, reject) => {
    pending.commands.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
}

function assertNoCardOverlap(cards, message) {
  for (let left = 0; left < cards.length; left++) {
    for (let right = left + 1; right < cards.length; right++) {
      const a = cards[left];
      const b = cards[right];
      const overlapsX = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1;
      const overlapsY = a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
      assert.equal(overlapsX && overlapsY, false, `${message}: ${a.id} overlaps ${b.id}`);
    }
  }
}

test("asset cards keep all columns populated and rebalance in a real browser", async t => {
  const configuredExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  const executablePath = browserPath();
  if (!existsSync(executablePath)) {
    if (configuredExecutable) throw new Error(`Configured Chrome executable does not exist: ${executablePath}`);
    t.skip(`Chrome is not installed at ${executablePath}; browser-level masonry checks were not run.`);
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), "lodestory-card-masonry-"));
  let chrome;
  let socket;
  let server;
  try {
    try {
      chrome = spawn(executablePath, ["--headless=new", "--disable-gpu", "--no-first-run",
        "--no-default-browser-check", "--remote-debugging-port=0", "--remote-allow-origins=*",
        `--user-data-dir=${profile}`, "about:blank"], {stdio: "ignore"});
    } catch (error) {
      if (error.code === "ENOENT") {
        t.skip(`Chrome is not installed at ${executablePath}; browser-level masonry checks were not run.`);
        return;
      }
      throw error;
    }
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
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, {once: true});
      socket.addEventListener("error", reject, {once: true});
    });

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
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });

    server = await createServer({
      configFile: false,
      cacheDir: path.join(profile, "vite-cache"),
      root: process.cwd(),
      appType: "mpa",
      server: {host: "127.0.0.1", port: 0, strictPort: true, hmr: false},
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");

    const target = await sendCdpCommand(socket, pending, "Target.createTarget", {url: "about:blank"});
    const attachment = await sendCdpCommand(socket, pending, "Target.attachToTarget",
      {targetId: target.targetId, flatten: true});
    const sessionId = attachment.sessionId;
    const send = (method, params = {}) => sendCdpCommand(socket, pending, method, params, sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false});
    await send("Page.navigate", {url: `http://127.0.0.1:${address.port}/tests/fixtures/asset-card-masonry.html`});

    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitForLayout = async count => waitFor(() => evaluate(`(() => {
      const list = document.querySelector('.asset-object-cards');
      return Boolean(window.__assetCardMasonryFixture && list.dataset.masonryReady === 'true'
        && list.children.length === ${count}
        && [...list.children].every(card => getComputedStyle(card).position === 'absolute'));
    })()`), `Cards did not finish masonry layout at count ${count}.`);
    const fixtureCall = (method, ...args) => {
      const settle = ["setCards", "addCard", "removeCard", "updateCardHeight", "setWidth"].includes(method)
        ? "await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));"
        : "";
      return evaluate(`(async () => {
        const value = await window.__assetCardMasonryFixture.${method}(${args.map(value => JSON.stringify(value)).join(",")});
        ${settle}
        return value;
      })()`);
    };
    const readCards = () => fixtureCall("snapshot");
    const readHorizontalBounds = () => evaluate(`(() => {
      const editor = document.querySelector('.asset-record-editor');
      const list = document.querySelector('.asset-object-cards');
      const rect = element => {
        const bounds = element.getBoundingClientRect();
        return {left: bounds.left, right: bounds.right};
      };
      const style = getComputedStyle(editor);
      return {
        editor: {...rect(editor), clientWidth: editor.clientWidth, scrollWidth: editor.scrollWidth,
          paddingLeft: Number.parseFloat(style.paddingLeft), paddingRight: Number.parseFloat(style.paddingRight)},
        list: rect(list),
        cards: [...list.children].map(card => {
          const bounds = card.getBoundingClientRect();
          return {id: card.dataset.cardId, left: bounds.left, right: bounds.right};
        }),
      };
    })()`);
    const assertHorizontalBounds = async (count, message) => {
      const {editor, list, cards} = await readHorizontalBounds();
      assert.equal(cards.length, count, `${message}: expected ${count} cards`);
      assert.ok(list.left >= editor.left + editor.paddingLeft - 1,
        `${message}: card list starts inside the editor's left padding`);
      assert.ok(list.right <= editor.right - editor.paddingRight + 1,
        `${message}: card list ends before the editor's right padding`);
      for (const card of cards) {
        assert.ok(card.left >= list.left - 1, `${message}: ${card.id} stays inside the list's left edge`);
        assert.ok(card.right <= list.right + 1, `${message}: ${card.id} stays inside the list's right edge`);
        assert.ok(editor.right - card.right >= editor.paddingRight - 1,
          `${message}: ${card.id} preserves the editor's right padding`);
      }
      assert.ok(editor.scrollWidth <= editor.clientWidth + 1,
        `${message}: cards do not create horizontal overflow in the editor`);
    };
    const assertColumnsPopulated = async count => {
      await waitForLayout(count);
      const cards = await readCards();
      const firstRow = cards.slice(0, Math.min(count, 3));
      assert.equal(new Set(firstRow.map(card => Math.round(card.y))).size, 1,
        `${count} cards begin across the first row`);
      assert.equal(new Set(cards.map(card => Math.round(card.x))).size, Math.min(count, 3),
        `${count} cards use every available column`);
      assertNoCardOverlap(cards, `${count} cards`);
      await assertHorizontalBounds(count, `${count}-card layout`);
      return cards;
    };
    const assertListContainsCards = async () => evaluate(`(() => {
      const list = document.querySelector('.asset-object-cards');
      const bottom = Math.max(...[...list.children].map(card => card.getBoundingClientRect().bottom));
      return list.getBoundingClientRect().bottom + 1 >= bottom;
    })()`);
    const cardsDoNotOverlap = cards => cards.every((card, index) => cards.slice(index + 1).every(other => {
      const overlapsX = card.x < other.x + other.width - 1 && other.x < card.x + card.width - 1;
      const overlapsY = card.y < other.y + other.height - 1 && other.y < card.y + card.height - 1;
      return !overlapsX || !overlapsY;
    }));

    await waitFor(() => evaluate("Boolean(window.__assetCardMasonryFixture)"), "The test fixture did not start.");
    await waitFor(() => evaluate("getComputedStyle(document.querySelector('.asset-object-cards')).gridTemplateColumns.split(/\\s+/).length === 3"),
      "Production card CSS did not produce three tracks at 1280px.");
    for (const count of [1, 2, 3, 4, 5, 7, 15]) {
      const cards = Array.from({length: count}, (_, index) => ({id: `card-${index + 1}`, height: 140}));
      await fixtureCall("setCards", cards);
      const layout = await assertColumnsPopulated(count);
      if (count === 4) {
        assert.equal(Math.round(layout[3].x), Math.round(layout[0].x), "the fourth equal-height card continues below column one");
        assert.ok(layout[3].y > layout[0].y, "the fourth card starts below the first row");
      }
      assert.equal(await assertListContainsCards(), true, `${count} cards fit inside the scrollable list`);
    }

    await fixtureCall("setCards", [
      {id: "tall", height: 260}, {id: "short", height: 110}, {id: "medium", height: 170},
      {id: "short-two", height: 120}, {id: "medium-two", height: 180}, {id: "short-three", height: 130},
      {id: "tall-two", height: 240},
    ]);
    const mixedCards = await assertColumnsPopulated(7);
    assert.ok(new Set(mixedCards.map(card => Math.round(card.y))).size > 2,
      "different content heights form a staggered visual layout");
    await fixtureCall("updateCardHeight", "short", 410);
    await waitFor(async () => {
      const cards = await readCards();
      return cards.find(card => card.id === "short")?.height === 410
        && cardsDoNotOverlap(cards)
        && await assertListContainsCards();
    }, "Changing card content height did not rebalance the layout.");
    assertNoCardOverlap(await readCards(), "content height change");
    await assertHorizontalBounds(7, "content height change");

    await fixtureCall("setWidth", 900);
    const twoColumn = await waitFor(async () => {
      const cards = await readCards();
      const track = await evaluate(`(() => {
        const list = document.querySelector('.asset-object-cards');
        const widths = getComputedStyle(list).gridTemplateColumns.match(/[0-9.]+px/g) ?? [];
        return {count: widths.length, width: Number.parseFloat(widths[0])};
      })()`);
      return track.count === 2 && cards.length === 7
        && cards.every(card => Math.abs(card.width - track.width) < 1)
        && new Set(cards.map(card => Math.round(card.x))).size === 2 ? cards : null;
    }, "Cards did not reflow at the two-column breakpoint.");
    assert.equal(new Set(twoColumn.slice(0, 2).map(card => Math.round(card.y))).size, 1,
      "the first row fills the two available columns after resize");
    assertNoCardOverlap(twoColumn, "two-column resize");
    await assertHorizontalBounds(7, "two-column resize");

    await fixtureCall("setWidth", 420);
    const oneColumn = await waitFor(async () => {
      const cards = await readCards();
      const track = await evaluate(`(() => {
        const list = document.querySelector('.asset-object-cards');
        const widths = getComputedStyle(list).gridTemplateColumns.match(/[0-9.]+px/g) ?? [];
        return {count: widths.length, width: Number.parseFloat(widths[0])};
      })()`);
      return track.count === 1 && cards.length === 7
        && cards.every(card => Math.abs(card.width - track.width) < 1)
        && new Set(cards.map(card => Math.round(card.x))).size === 1 ? cards : null;
    }, "Cards did not reflow at the one-column breakpoint.");
    assertNoCardOverlap(oneColumn, "one-column resize");
    await assertHorizontalBounds(7, "one-column resize");

    await fixtureCall("setWidth", 1280);
    await fixtureCall("setCards", [
      {id: "keep-1", height: 160}, {id: "keep-2", height: 100}, {id: "keep-3", height: 210},
    ]);
    await assertColumnsPopulated(3);
    await fixtureCall("addCard", {id: "added", height: 120});
    const fourCards = await assertColumnsPopulated(4);
    assert.deepEqual(fourCards.map(card => card.id), ["keep-1", "keep-2", "keep-3", "added"],
      "adding items keeps their DOM order for keyboard navigation");
    await fixtureCall("removeCard", "keep-2");
    const filteredCards = await assertColumnsPopulated(3);
    assert.deepEqual(filteredCards.map(card => card.id), ["keep-1", "keep-3", "added"],
      "removing a filtered item reflows remaining items without changing their DOM order");

    await fixtureCall("cleanup");
    assert.equal(await evaluate("document.querySelector('.asset-object-cards').dataset.masonryReady === undefined"), true,
      "cleanup removes the ready state");
    assert.equal(await evaluate(`[...document.querySelectorAll('.asset-object-card')].every(card =>
      card.style.position === '' && card.style.width === '' && card.style.insetInlineStart === '' && card.style.top === '')`), true,
    "cleanup restores card inline styles");
    assert.equal(await evaluate("document.querySelector('.asset-object-cards').style.height === ''"), true,
      "cleanup restores the natural list height");
    assert.deepEqual(pageErrors, [], "the browser reports no asset card layout errors");
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await new Promise(resolve => chrome.once("exit", resolve));
    }
    await server?.close();
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
