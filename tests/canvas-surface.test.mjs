import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/plugins/canvas/CanvasSurface.tsx", import.meta.url), "utf8"), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? [];
    list.push({listener, options});
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter(entry => entry.listener !== listener));
  }

  dispatch(type, event = {}) {
    for (const {listener} of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(type) { return (this.listeners.get(type) ?? []).length; }
}

class FakeElement extends FakeEventTarget {
  constructor(rect = {left: 0, top: 0, width: 800, height: 600}, tagName = "div") {
    super();
    this.rect = rect;
    this.tagName = tagName.toLowerCase();
    this.parentElement = null;
    this.captured = new Set();
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (selector.split(",").some(part => current.matches(part.trim()))) return current;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith("[")) return false;
    const editable = selector.match(/^\[contenteditable='([^']+)'\]$/);
    return editable ? this.contentEditable === editable[1] : this.tagName === selector;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }

  getBoundingClientRect() { return this.rect; }
  focus() { this.focused = true; }
  setPointerCapture(pointerId) { this.captured.add(pointerId); }
  hasPointerCapture(pointerId) { return this.captured.has(pointerId); }
  releasePointerCapture(pointerId) { this.captured.delete(pointerId); }
}

class FakeResizeObserver {
  static instances = [];
  constructor(callback) { this.callback = callback; this.disconnected = false; FakeResizeObserver.instances.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}

function jsx(type, props, key) { return {type, props: props ?? {}, key: key ?? null}; }
const jsxRuntime = {jsx, jsxs: jsx};

function makeViewport() {
  let snapshot = Object.freeze({center: Object.freeze({x: 0, y: 0}), zoom: 1, disposed: false});
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    panBy(x, y) {
      calls.push({kind: "pan", x, y});
      snapshot = Object.freeze({center: Object.freeze({x: snapshot.center.x - x / snapshot.zoom, y: snapshot.center.y - y / snapshot.zoom}), zoom: snapshot.zoom, disposed: false});
      for (const listener of [...listeners]) listener();
      return true;
    },
    zoomTo(zoom, anchor) {
      calls.push({kind: "zoom", zoom, anchor});
      snapshot = Object.freeze({...snapshot, zoom, disposed: false});
      for (const listener of [...listeners]) listener();
      return true;
    },
    resetZoom() { calls.push({kind: "reset-zoom"}); return true; },
    resetView() { calls.push({kind: "reset-view"}); return true; },
    listenerCount: () => listeners.size,
  };
}

function loadSurface({raf = false} = {}) {
  const hooks = [];
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  let nextFrameId = 0;
  const pendingFrames = new Map();
  const allFrames = new Map();
  if (raf) {
    window.requestAnimationFrame = callback => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      allFrames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = id => pendingFrames.delete(id);
  }
  document.hidden = false;
  FakeResizeObserver.instances = [];
  let cursor = 0;
  let pendingLayouts = [];
  let pendingStores = [];

  const react = {
    useId() { cursor++; return ":canvas-surface:"; },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ?? (hooks[index] = {current: initial});
    },
    useState(initial) {
      const index = cursor++;
      const slot = hooks[index] ?? (hooks[index] = {value: initial});
      return [slot.value, value => { slot.value = typeof value === "function" ? value(slot.value) : value; }];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++;
      const slot = hooks[index] ?? (hooks[index] = {kind: "store", subscribe: undefined, unsubscribe: undefined});
      slot.nextSubscribe = subscribe;
      pendingStores.push(slot);
      return getSnapshot();
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++;
      const slot = hooks[index] ?? (hooks[index] = {kind: "layout", deps: undefined, cleanup: undefined});
      pendingLayouts.push({slot, effect, deps});
    },
  };

  const module = {exports: {}};
  const ui = {Button: "Button", Icon: "Icon", IconButton: "IconButton"};
  const context = {
    module,
    exports: module.exports,
    window,
    document,
    Element: FakeElement,
    ResizeObserver: FakeResizeObserver,
    console,
    require(specifier) {
      if (specifier === "react") return react;
      if (specifier === "react/jsx-runtime") return jsxRuntime;
      if (specifier === "@lodestory/ui") return ui;
      if (specifier === "./canvas.css") return {};
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.runInNewContext(compiled, context, {filename: "CanvasSurface.js"});
  const renderSurface = module.exports.CanvasSurface;
  let output;

  function render(props) {
    cursor = 0;
    pendingLayouts = [];
    pendingStores = [];
    output = renderSurface(props);
    return output;
  }

  function commit() {
    // React cleans changed layout effects before running the new effects.
    for (const {slot, deps} of pendingLayouts) {
      const changed = !slot.deps || deps.length !== slot.deps.length || deps.some((dep, index) => !Object.is(dep, slot.deps[index]));
      if (changed) slot.cleanup?.();
    }
    for (const {slot, effect, deps} of pendingLayouts) {
      const changed = !slot.deps || deps.length !== slot.deps.length || deps.some((dep, index) => !Object.is(dep, slot.deps[index]));
      if (changed) {
        slot.cleanup = effect() ?? undefined;
        slot.deps = deps;
      }
    }
    for (const slot of pendingStores) {
      if (slot.subscribe !== slot.nextSubscribe) {
        slot.unsubscribe?.();
        slot.subscribe = slot.nextSubscribe;
        slot.unsubscribe = slot.subscribe(() => {});
      }
    }
  }

  function unmount() {
    for (const slot of hooks) {
      if (slot?.kind === "layout") slot.cleanup?.();
      if (slot?.kind === "store") slot.unsubscribe?.();
    }
  }

  return {
    render,
    commit,
    unmount,
    window,
    document,
    get output() { return output; },
    get pendingFrameIds() { return [...pendingFrames.keys()]; },
    runAnimationFrame() {
      const frames = [...pendingFrames.entries()];
      pendingFrames.clear();
      for (const [, callback] of frames) callback(16);
      return frames.map(([id]) => id);
    },
    runFrameCallback(id) { allFrames.get(id)?.(16); },
  };
}

function pointerEvent(surface, {pointerId = 1, button = 0, x = 100, y = 100} = {}) {
  return {currentTarget: surface, target: surface, pointerId, button, clientX: x, clientY: y, preventDefault() { this.defaultPrevented = true; }};
}

function wheelEvent(surface, {deltaX = 0, deltaY = 0, ctrlKey = false, metaKey = false, x = 230, y = 190} = {}) {
  return {
    target: surface,
    deltaMode: 0,
    deltaX,
    deltaY,
    ctrlKey,
    metaKey,
    clientX: x,
    clientY: y,
    preventDefault() { this.defaultPrevented = true; },
  };
}

function createMountedSurface({viewport = makeViewport(), active = true, raf = false} = {}) {
  const renderer = loadSurface({raf});
  const surface = new FakeElement({left: 80, top: 40, width: 800, height: 600});
  const output = renderer.render({viewport, active, label: "时间线"});
  output.props.ref.current = surface;
  renderer.commit();
  return {renderer, surface, viewport, output};
}

test("without requestAnimationFrame, middle drag keeps synchronous pan behavior", () => {
  const {renderer, surface, viewport, output} = createMountedSurface();
  output.props.onPointerDown(pointerEvent(surface, {button: 0, x: 10, y: 20}));
  output.props.onPointerMove(pointerEvent(surface, {x: 80, y: 90}));
  assert.deepEqual(viewport.calls, []);

  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 7, x: 10, y: 20}));
  assert.equal(surface.hasPointerCapture(7), true);
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 7, x: 24, y: 37}));
  assert.deepEqual(viewport.calls, [{kind: "pan", x: 14, y: 17}]);
  output.props.onPointerUp(pointerEvent(surface, {pointerId: 7, button: 1, x: 24, y: 37}));
  assert.equal(surface.hasPointerCapture(7), false);
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 7, x: 90, y: 90}));
  assert.equal(viewport.calls.length, 1, "moves after pointerup cannot pan");
  renderer.unmount();
});

test("pointer moves coalesce per frame and pointerup flushes the final displacement once", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 8, x: 100, y: 100}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 8, x: 110, y: 105}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 8, x: 125, y: 120}));
  assert.deepEqual(viewport.calls, [], "pointer input is queued until the frame");
  assert.equal(renderer.pendingFrameIds.length, 1, "multiple moves schedule one frame");
  const [firstFrame] = renderer.runAnimationFrame();
  assert.deepEqual(viewport.calls, [{kind: "pan", x: 25, y: 20}]);

  output.props.onPointerMove(pointerEvent(surface, {pointerId: 8, x: 130, y: 126}));
  const [lastFrame] = renderer.pendingFrameIds;
  output.props.onPointerUp(pointerEvent(surface, {pointerId: 8, button: 1, x: 132, y: 129}));
  assert.deepEqual(viewport.calls, [
    {kind: "pan", x: 25, y: 20},
    {kind: "pan", x: 7, y: 9},
  ], "pointerup applies queued and terminal displacement immediately");
  assert.deepEqual(renderer.pendingFrameIds, []);
  renderer.runFrameCallback(lastFrame);
  renderer.runFrameCallback(firstFrame);
  assert.equal(viewport.calls.length, 2, "canceled or repeated callbacks cannot duplicate a pan");
  renderer.unmount();
});

test("Space keyup, blur, and pointer cancellation flush queued drag movement", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});

  renderer.window.dispatch("keydown", {code: "Space", target: surface, isComposing: false, ctrlKey: false, metaKey: false, altKey: false});
  output.props.onPointerDown(pointerEvent(surface, {button: 0, pointerId: 32, x: 0, y: 0}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 32, x: 20, y: 12}));
  renderer.window.dispatch("keyup", {code: "Space"});

  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 33, x: 0, y: 0}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 33, x: 3, y: 4}));
  output.props.onBlur({currentTarget: surface, relatedTarget: null});

  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 34, x: 0, y: 0}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 34, x: 7, y: 9}));
  output.props.onPointerCancel(pointerEvent(surface, {pointerId: 34}));

  assert.deepEqual(viewport.calls, [
    {kind: "pan", x: 20, y: 12},
    {kind: "pan", x: 3, y: 4},
    {kind: "pan", x: 7, y: 9},
  ]);
  assert.deepEqual(renderer.pendingFrameIds, []);
  renderer.unmount();
});

test("wheel pans coalesce and flush before zoom, keyboard pan, and reset", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});
  surface.dispatch("wheel", wheelEvent(surface, {deltaX: 3, deltaY: 4}));
  surface.dispatch("wheel", wheelEvent(surface, {deltaX: 2, deltaY: 6}));
  assert.deepEqual(viewport.calls, []);
  assert.equal(renderer.pendingFrameIds.length, 1);

  surface.dispatch("wheel", wheelEvent(surface, {deltaY: -100, ctrlKey: true}));
  assert.deepEqual(viewport.calls.map(call => call.kind), ["pan", "zoom"], "zoom follows all earlier wheel pan input");
  assert.deepEqual(viewport.calls[0], {kind: "pan", x: -5, y: -10});
  assert.ok(Math.abs(viewport.calls[1].zoom - Math.exp(0.2)) < 1e-9);

  surface.dispatch("wheel", wheelEvent(surface, {deltaX: 1, deltaY: 2}));
  output.props.onKeyDown({
    key: "ArrowLeft", code: "ArrowLeft", target: surface, nativeEvent: {isComposing: false},
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {},
  });
  assert.deepEqual(viewport.calls.slice(2), [
    {kind: "pan", x: -1, y: -2},
    {kind: "pan", x: 48, y: 0},
  ], "keyboard pan remains synchronous and follows queued wheel movement");

  surface.dispatch("wheel", wheelEvent(surface, {deltaY: 5}));
  output.props.onKeyDown({
    key: "Home", code: "Home", target: surface, nativeEvent: {isComposing: false},
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {},
  });
  assert.deepEqual(viewport.calls.slice(4), [
    {kind: "pan", x: 0, y: -5},
    {kind: "reset-view"},
  ], "reset follows the latest queued pan");
  renderer.unmount();
});

test("canvas zoom and reset controls flush pending wheel movement first", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});
  const controls = output.props.children.at(-1).props.children;
  const zoomIn = controls[2].props.onClick;
  const resetZoom = controls[1].props.children.props.onClick;
  const resetView = controls[3].props.onClick;

  surface.dispatch("wheel", wheelEvent(surface, {deltaX: 1, deltaY: 2}));
  zoomIn();
  assert.deepEqual(viewport.calls.slice(0, 2), [
    {kind: "pan", x: -1, y: -2},
    {kind: "zoom", zoom: 1.25, anchor: undefined},
  ]);

  surface.dispatch("wheel", wheelEvent(surface, {deltaY: 3}));
  resetZoom();
  assert.deepEqual(viewport.calls.slice(2), [
    {kind: "pan", x: 0, y: -3},
    {kind: "reset-zoom"},
  ]);

  surface.dispatch("wheel", wheelEvent(surface, {deltaY: 4}));
  resetView();
  assert.deepEqual(viewport.calls.slice(4), [
    {kind: "pan", x: 0, y: -4},
    {kind: "reset-view"},
  ]);
  renderer.unmount();
});

test("a held Space enables left-button panning until capture is released", () => {
  const {renderer, surface, viewport, output} = createMountedSurface();
  renderer.window.dispatch("keydown", {code: "Space", target: surface, isComposing: false, ctrlKey: false, metaKey: false, altKey: false});
  output.props.onPointerDown(pointerEvent(surface, {button: 0, pointerId: 3, x: 5, y: 9}));
  assert.equal(surface.hasPointerCapture(3), true);
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 3, x: 25, y: 29}));
  assert.deepEqual(viewport.calls, [{kind: "pan", x: 20, y: 20}]);
  renderer.window.dispatch("keyup", {code: "Space"});
  assert.equal(surface.hasPointerCapture(3), false, "releasing Space terminates the active drag");
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 3, x: 50, y: 50}));
  assert.equal(viewport.calls.length, 1);
  renderer.unmount();
});

test("Ctrl-wheel forwards a surface-local anchor and prevents page scrolling", () => {
  const {renderer, surface, viewport} = createMountedSurface();
  let prevented = false;
  surface.dispatch("wheel", {
    target: surface,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -100,
    ctrlKey: true,
    metaKey: false,
    clientX: 230,
    clientY: 190,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(viewport.calls.length, 1);
  assert.equal(viewport.calls[0].kind, "zoom");
  assert.ok(Math.abs(viewport.calls[0].zoom - Math.exp(0.2)) < 1e-9);
  assert.equal(viewport.calls[0].anchor.point.x, 150);
  assert.equal(viewport.calls[0].anchor.point.y, 150);
  assert.equal(viewport.calls[0].anchor.size.width, 800);
  assert.equal(viewport.calls[0].anchor.size.height, 600);
  renderer.unmount();
});

test("active=false detaches native listeners and cancels capture without moving the viewport", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 11}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 11, x: 140, y: 160}));
  const [staleFrame] = renderer.pendingFrameIds;
  assert.equal(surface.hasPointerCapture(11), true);
  assert.equal(renderer.pendingFrameIds.length, 1);
  assert.equal(surface.listenerCount("wheel"), 1);
  assert.equal(renderer.window.listenerCount("blur"), 1);
  assert.equal(renderer.document.listenerCount("visibilitychange"), 1);

  const inactive = renderer.render({viewport, active: false, label: "时间线"});
  inactive.props.ref.current = surface;
  renderer.commit();
  assert.equal(surface.hasPointerCapture(11), false);
  assert.equal(surface.listenerCount("wheel"), 0);
  assert.equal(renderer.window.listenerCount("blur"), 0);
  assert.equal(renderer.window.listenerCount("keydown"), 0);
  assert.equal(renderer.document.listenerCount("visibilitychange"), 0);
  assert.deepEqual(renderer.pendingFrameIds, [], "stopping cancels a queued frame");
  renderer.runFrameCallback(staleFrame);
  inactive.props.onPointerMove(pointerEvent(surface, {pointerId: 11, x: 200, y: 200}));
  assert.deepEqual(viewport.calls, []);
  renderer.unmount();
  assert.equal(FakeResizeObserver.instances.every(observer => observer.disconnected), true);
});

test("swapping the viewport and blurring end the old drag and unsubscribe old viewports", () => {
  const first = makeViewport();
  const second = makeViewport();
  const {renderer, surface, output} = createMountedSurface({viewport: first, raf: true});
  assert.equal(first.listenerCount(), 1);
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 21}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 21, x: 130, y: 140}));
  const [staleFrame] = renderer.pendingFrameIds;
  assert.equal(surface.hasPointerCapture(21), true);

  const swapped = renderer.render({viewport: second, active: true, label: "另一条时间线"});
  swapped.props.ref.current = surface;
  renderer.commit();
  assert.equal(surface.hasPointerCapture(21), false);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  assert.equal(surface.listenerCount("wheel"), 1, "the surface has exactly one listener for the new viewport");
  assert.deepEqual(renderer.pendingFrameIds, [], "swapping discards the old viewport's queued pan and frame");
  renderer.runFrameCallback(staleFrame);
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, [], "an old callback cannot pan the new viewport");
  swapped.props.onPointerMove(pointerEvent(surface, {pointerId: 21, x: 200, y: 200}));
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, []);

  swapped.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 22}));
  swapped.props.onBlur({currentTarget: surface, relatedTarget: null});
  assert.equal(surface.hasPointerCapture(22), false);
  swapped.props.onPointerMove(pointerEvent(surface, {pointerId: 22, x: 200, y: 200}));
  assert.deepEqual(second.calls, []);
  renderer.unmount();
  assert.equal(second.listenerCount(), 0);
  assert.equal(surface.listenerCount("wheel"), 0);
  assert.equal(renderer.window.listenerCount("blur"), 0);
});

test("unmount cancels pending frame callbacks without applying the queued pan", () => {
  const {renderer, surface, viewport, output} = createMountedSurface({raf: true});
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 41}));
  output.props.onPointerMove(pointerEvent(surface, {pointerId: 41, x: 140, y: 150}));
  const [staleFrame] = renderer.pendingFrameIds;
  assert.equal(renderer.pendingFrameIds.length, 1);

  renderer.unmount();
  assert.deepEqual(renderer.pendingFrameIds, []);
  renderer.runFrameCallback(staleFrame);
  assert.deepEqual(viewport.calls, []);
  assert.equal(viewport.listenerCount(), 0);
  assert.equal(surface.listenerCount("wheel"), 0);
  assert.equal(renderer.window.listenerCount("blur"), 0);
});
