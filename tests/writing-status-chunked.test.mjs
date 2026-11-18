import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createI18nFixture} from "./helpers/i18nFixture.mjs";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

function createScheduler() {
  const queue = [];
  const channels = [];
  const timers = new Map();
  let nextTimer = 0;
  class TestMessageChannel {
    constructor() {
      const channel = this;
      this.closed = false;
      this.port1 = {
        onmessage: null,
        close() { channel.closed = true; },
      };
      this.port2 = {
        postMessage() { queue.push(() => channel.port1.onmessage?.({data: 0})); },
        close() { channel.closed = true; },
      };
      channels.push(this);
    }
  }
  return {
    queue, channels, timers, TestMessageChannel,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    flushTasks() {
      let turns = 0;
      while (queue.length || timers.size) {
        if (++turns > 10_000) throw new Error("Chunk counter did not finish.");
        if (queue.length) queue.shift()();
        else {
          const [id, callback] = timers.entries().next().value;
          timers.delete(id);
          callback();
        }
      }
    },
    fireOne() {
      if (queue.length) queue.shift()();
      else if (timers.size) {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
      }
    },
  };
}

function createHookReact() {
  const hooks = [];
  let index = 0;
  let pendingEffects = [];
  let stateUpdates = 0;
  const equalDeps = (left, right) => left && right && left.length === right.length
    && left.every((value, i) => Object.is(value, right[i]));
  return {
    beginRender() { index = 0; pendingEffects = []; },
    commitEffects() {
      for (const effect of pendingEffects) {
        hooks[effect.index]?.cleanup?.();
        const cleanup = effect.create();
        hooks[effect.index] = {kind: "effect", deps: effect.deps, cleanup};
      }
      pendingEffects = [];
    },
    unmount() {
      for (const hook of hooks) hook?.kind === "effect" && hook.cleanup?.();
    },
    get stateUpdates() { return stateUpdates; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useMemo(factory, deps) {
      const slot = index++;
      const previous = hooks[slot];
      if (!previous || !equalDeps(previous.deps, deps)) hooks[slot] = {kind: "memo", deps, value: factory()};
      return hooks[slot].value;
    },
    useState(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = {kind: "state", value: typeof initial === "function" ? initial() : initial};
      return [hooks[slot].value, value => {
        stateUpdates++;
        hooks[slot].value = typeof value === "function" ? value(hooks[slot].value) : value;
      }];
    },
    useEffect(create, deps) {
      const slot = index++;
      const previous = hooks[slot];
      if (!previous || !equalDeps(previous.deps, deps)) pendingEffects.push({index: slot, create, deps});
    },
  };
}

async function loadHarness({scheduler = createScheduler(), counter = () => 777, clock = () => performance.now(), withChannel = true} = {}) {
  const {loadModule} = createMainFixture();
  const {i18n, stop} = createI18nFixture(loadModule);
  i18n.registerMessages("writing-status", loadModule("plugins/writing-status/i18n.ts").writingStatusMessages);
  const countExports = {countDocumentCharacters: counter};
  const chunkExports = {};
  const chunkContext = {
    exports: chunkExports,
    MessageChannel: withChannel ? scheduler.TestMessageChannel : undefined,
    performance: {now: clock},
    setTimeout: callback => scheduler.setTimeout(callback),
    clearTimeout: id => scheduler.clearTimeout(id),
  };
  vm.runInNewContext(await compile("../src/plugins/writing-status/chunkedCharacterCount.ts"), chunkContext);

  const React = createHookReact();
  const jsxRuntime = {
    jsx(type, props) { return {type, props: props ?? {}}; },
    jsxs(type, props) { return {type, props: props ?? {}}; },
    Fragment: Symbol("Fragment"),
  };
  const editorExports = {};
  vm.runInNewContext(await compile("../src/plugins/writing-status/EditorStatusBar.tsx"), {
    exports: editorExports,
    React,
    require(specifier) {
      if (specifier === "react") return React;
      if (specifier === "react/jsx-runtime") return jsxRuntime;
      if (specifier === "@lodestory/ui") return {Icon: () => null};
      if (specifier === "./countDocumentCharacters") return countExports;
      if (specifier === "./chunkedCharacterCount") return chunkExports;
      throw new Error(`Unexpected import ${specifier}`);
    },
  });

  function render(props) {
    React.beginRender();
    const tree = editorExports.EditorStatusBar({...props, i18n});
    React.commitEffects();
    return tree;
  }
  return {scheduler, React, render, i18n, unmount() { React.unmount(); void stop(); }};
}

function textContent(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node.props ? textContent(node.props.children) : "";
}

function document(id) {
  return {id, fileName: "story.txt", saveState: "pending"};
}

test("small text stays synchronous and large plain text starts with an explicit pending label", async () => {
  let syncCalls = 0;
  const harness = await loadHarness({counter: () => { syncCalls++; return 42; }});
  const small = {document: document("small"), text: "hello"};
  assert.match(textContent(harness.render(small)), /文稿 42 字/);
  assert.equal(syncCalls, 1);

  const large = {document: document("large"), text: "a".repeat(1024 * 1024)};
  assert.match(textContent(harness.render(large)), /文稿 统计中…/);
  assert.equal(syncCalls, 1, "large TXT must not run the synchronous counter during render");
  await harness.i18n.setLocale("en");
  assert.match(textContent(harness.render(large)), /Manuscript · Counting…/);
  assert.equal(harness.scheduler.channels.length, 1, "locale changes do not restart counting");
  harness.unmount();
  assert.equal(harness.scheduler.channels[0].closed, true);
});

test("large TXT completion uses the current document and text version only", async () => {
  const scheduler = createScheduler();
  const harness = await loadHarness({scheduler});
  const first = {document: document("first"), text: "A".repeat(1024 * 1024)};
  const second = {document: document("second"), text: "B".repeat(1024 * 1024) + "😀"};

  assert.match(textContent(harness.render(first)), /统计中…/);
  const firstChannel = scheduler.channels[0];
  assert.match(textContent(harness.render(second)), /统计中…/);
  assert.equal(firstChannel.closed, true, "switching documents cancels the previous task");
  scheduler.flushTasks();
  assert.equal(harness.React.stateUpdates, 1, "only the current document task may publish");
  assert.match(textContent(harness.render(second)), /文稿 1,048,577 字/);

  const pending = {document: document("unmounted"), text: "C".repeat(1024 * 1024)};
  harness.render(pending);
  const updatesBeforeUnmount = harness.React.stateUpdates;
  const unmountedChannel = scheduler.channels.at(-1);
  harness.unmount();
  scheduler.flushTasks();
  assert.equal(unmountedChannel.closed, true);
  assert.equal(harness.React.stateUpdates, updatesBeforeUnmount, "unmounted task cannot publish");
});

test("hidden document details skip counting", async () => {
  let syncCalls = 0;
  const scheduler = createScheduler();
  const harness = await loadHarness({scheduler, counter: () => { syncCalls++; return 17; }});
  const hidden = {document: document("hidden"), text: "x".repeat(1024 * 1024), showDocumentDetails: false};
  const hiddenText = textContent(harness.render(hidden));
  assert.doesNotMatch(hiddenText, /文稿|字/);
  assert.equal(syncCalls, 0);
  assert.equal(scheduler.channels.length, 0, "hidden status does not start a large TXT task");
});

test("chunk boundaries preserve exact Unicode whitespace and surrogate semantics", async () => {
  const scheduler = createScheduler();
  const countModule = {};
  const compiled = await compile("../src/plugins/writing-status/countDocumentCharacters.ts");
  vm.runInNewContext(compiled, {exports: countModule});
  const chunkModule = {};
  vm.runInNewContext(await compile("../src/plugins/writing-status/chunkedCharacterCount.ts"), {
    exports: chunkModule,
    MessageChannel: scheduler.TestMessageChannel,
    performance,
    setTimeout: callback => scheduler.setTimeout(callback),
    clearTimeout: id => scheduler.clearTimeout(id),
  });
  const text = "A".repeat(65_535) + "\ud83d" + " ".repeat(65_535) + "\ude00B\ud800";
  let result;
  chunkModule.startChunkedCharacterCount(text, count => { result = count; });
  assert.equal(result, undefined, "the initial chunk is asynchronous");
  scheduler.flushTasks();
  assert.equal(result, countModule.countDocumentCharacters(text));
  assert.equal(result, 65_538);
  assert.equal(scheduler.channels[0].closed, true);
});

test("cancelled tasks and timer fallback release resources without late callbacks", async () => {
  const scheduler = createScheduler();
  const harness = await loadHarness({scheduler});
  const props = {document: document("cancel"), text: "x".repeat(1024 * 1024)};
  harness.render(props);
  const channel = scheduler.channels[0];
  harness.unmount();
  scheduler.flushTasks();
  assert.equal(channel.closed, true);
  assert.equal(harness.React.stateUpdates, 0);

  const fallback = createScheduler();
  const {startChunkedCharacterCount} = await loadChunkedModule(fallback, false);
  let called = false;
  const cancel = startChunkedCharacterCount("x".repeat(200_000), () => { called = true; });
  assert.equal(fallback.timers.size, 1);
  cancel();
  assert.equal(fallback.timers.size, 0);
  fallback.flushTasks();
  assert.equal(called, false);
});

test("statistics failures close the channel and expose a failure label", async () => {
  const scheduler = createScheduler();
  const harness = await loadHarness({scheduler, clock: () => { throw new Error("clock unavailable"); }});
  const props = {document: document("failure"), text: "x".repeat(1024 * 1024)};
  assert.match(textContent(harness.render(props)), /统计中…/);
  const channel = scheduler.channels[0];
  scheduler.fireOne();
  assert.equal(channel.closed, true);
  assert.match(textContent(harness.render(props)), /文稿 统计失败/);
});

async function loadChunkedModule(scheduler, withChannel = true, clock = () => performance.now()) {
  const exports = {};
  vm.runInNewContext(await compile("../src/plugins/writing-status/chunkedCharacterCount.ts"), {
    exports,
    MessageChannel: withChannel ? scheduler.TestMessageChannel : undefined,
    performance: {now: clock},
    setTimeout: callback => scheduler.setTimeout(callback),
    clearTimeout: id => scheduler.clearTimeout(id),
  });
  return exports;
}

test("chunked counting yields on the time budget and remains bounded when the clock stalls", async () => {
  const fastClockScheduler = createScheduler();
  let clock = 0;
  const fastClock = await loadChunkedModule(fastClockScheduler, true, () => {
    clock += 4;
    return clock;
  });
  const longText = "x".repeat(130_000);
  let fastClockResult;
  fastClock.startChunkedCharacterCount(longText, count => { fastClockResult = count; });

  fastClockScheduler.fireOne();
  assert.equal(fastClockResult, undefined, "the first time-budgeted task yields before finishing the text");
  assert.ok(fastClockScheduler.queue.length > 0, "the continuation is scheduled as another task");
  fastClockScheduler.flushTasks();
  assert.equal(fastClockResult, longText.length);
  assert.equal(fastClockScheduler.channels[0].closed, true);

  const stalledClockScheduler = createScheduler();
  const stalledClock = await loadChunkedModule(stalledClockScheduler, true, () => 0);
  const hardLimitText = "y".repeat(64 * 1024 + 1);
  let stalledClockResult;
  stalledClock.startChunkedCharacterCount(hardLimitText, count => { stalledClockResult = count; });

  stalledClockScheduler.fireOne();
  assert.equal(stalledClockResult, undefined, "the hard unit cap yields even when elapsed time cannot be measured");
  assert.ok(stalledClockScheduler.queue.length > 0, "the remaining text is scheduled for another task");
  stalledClockScheduler.flushTasks();
  assert.equal(stalledClockResult, hardLimitText.length);
  assert.equal(stalledClockScheduler.channels[0].closed, true);
});
