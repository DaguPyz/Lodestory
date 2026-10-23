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
    resetZoom() { return true; },
    resetView() { return true; },
    listenerCount: () => listeners.size,
  };
}

function loadSurface() {
  const hooks = [];
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
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

  return {render, commit, unmount, window, document, get output() { return output; }};
}

function pointerEvent(surface, {pointerId = 1, button = 0, x = 100, y = 100} = {}) {
  return {currentTarget: surface, target: surface, pointerId, button, clientX: x, clientY: y, preventDefault() { this.defaultPrevented = true; }};
}

function createMountedSurface({viewport = makeViewport(), active = true} = {}) {
  const renderer = loadSurface();
  const surface = new FakeElement({left: 80, top: 40, width: 800, height: 600});
  const output = renderer.render({viewport, active, label: "时间线"});
  output.props.ref.current = surface;
  renderer.commit();
  return {renderer, surface, viewport, output};
}

test("ordinary left drag does not pan, while middle drag pans and releases capture", () => {
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
  const {renderer, surface, viewport, output} = createMountedSurface();
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 11}));
  assert.equal(surface.hasPointerCapture(11), true);
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
  inactive.props.onPointerMove(pointerEvent(surface, {pointerId: 11, x: 200, y: 200}));
  assert.deepEqual(viewport.calls, []);
  renderer.unmount();
  assert.equal(FakeResizeObserver.instances.every(observer => observer.disconnected), true);
});

test("swapping the viewport and blurring end the old drag and unsubscribe old viewports", () => {
  const first = makeViewport();
  const second = makeViewport();
  const {renderer, surface, output} = createMountedSurface({viewport: first});
  assert.equal(first.listenerCount(), 1);
  output.props.onPointerDown(pointerEvent(surface, {button: 1, pointerId: 21}));
  assert.equal(surface.hasPointerCapture(21), true);

  const swapped = renderer.render({viewport: second, active: true, label: "另一条时间线"});
  swapped.props.ref.current = surface;
  renderer.commit();
  assert.equal(surface.hasPointerCapture(21), false);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  assert.equal(surface.listenerCount("wheel"), 1, "the surface has exactly one listener for the new viewport");
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
