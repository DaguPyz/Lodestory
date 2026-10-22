import React, {useEffect} from "react";
import {createRoot, type Root} from "react-dom/client";
import {DefaultLayout} from "../../src/plugins/default-layout/DefaultLayout";
import {createNavigationWidthModel, navigationWidthConfig} from "../../src/plugins/default-layout/navigationWidth";
import "../../src/styles/tokens.css";

declare global {
  interface Window {
    __navigationResizeHarness: {
      mount(strictMode?: boolean): void;
      unmount(): void;
      getState(): {writes: (number | null)[]; mounts: number; effectiveWidth: number; shownNavigationId: string | null};
    };
    __navigationResizeMounts: number;
    __navigationEditorNode?: Element | null;
  }
}

window.__navigationResizeMounts = 0;

const configWrites: (number | null)[] = [];
const configListeners = new Set<() => void>();
let configValue: number | null = 420;
const config = {
  register(item: typeof navigationWidthConfig) {
    if (item !== navigationWidthConfig) throw new Error("Unexpected layout config item.");
    return () => {};
  },
  getSnapshot(item: typeof navigationWidthConfig) {
    if (item !== navigationWidthConfig) throw new Error("Unexpected layout config item.");
    return configValue;
  },
  subscribe(item: typeof navigationWidthConfig, listener: () => void) {
    if (item !== navigationWidthConfig) throw new Error("Unexpected layout config item.");
    configListeners.add(listener);
    return () => configListeners.delete(listener);
  },
  async set(item: typeof navigationWidthConfig, value: number | null) {
    if (item !== navigationWidthConfig) throw new Error("Unexpected layout config item.");
    configValue = value;
    configWrites.push(value);
    for (const listener of [...configListeners]) listener();
  },
  async reset(item: typeof navigationWidthConfig) {
    if (item !== navigationWidthConfig) throw new Error("Unexpected layout config item.");
    configValue = null;
    configWrites.push(null);
    for (const listener of [...configListeners]) listener();
  },
};

const widths = createNavigationWidthModel(config);

function BodyEditorProbe() {
  useEffect(() => {
    window.__navigationResizeMounts += 1;
    window.__navigationEditorNode = document.getElementById("body-editor-probe");
    return () => {
      window.__navigationResizeMounts -= 1;
      if (window.__navigationEditorNode === document.getElementById("body-editor-probe")) {
        window.__navigationEditorNode = null;
      }
    };
  }, []);
  return <textarea id="body-editor-probe" defaultValue="正文内容保持不变" />;
}

const navigation = {
  id: "navigation-test",
  title: "工程",
  role: "navigation" as const,
  order: 0,
  render: () => <div>导航面板</div>,
};
const outline = {
  id: "outline-test",
  title: "大纲",
  role: "navigation" as const,
  order: 1,
  render: () => <div>大纲面板</div>,
};
const main = {
  id: "main-test",
  title: "正文",
  role: "main" as const,
  order: 0,
  render: () => <BodyEditorProbe />,
};
const contents = Object.freeze([navigation, outline, main]);
let shownIds = new Set([navigation.id, main.id]);
const listeners = new Set<() => void>();
let snapshot = Object.freeze({contents, shownIds: Object.freeze([...shownIds])});
let state = Object.freeze({snapshot, navigationDocked: true, auxiliaryDocked: false});
function publish() {
  snapshot = Object.freeze({contents, shownIds: Object.freeze([...shownIds])});
  state = Object.freeze({...state, snapshot});
  for (const listener of [...listeners]) listener();
}
const store = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setViewport: (_width: number, _rem: number) => {},
  show(id: string) {
    const entry = contents.find(item => item.id === id);
    if (!entry) return;
    const next = new Set(shownIds);
    if (entry.role === "navigation" || entry.role === "auxiliary") {
      for (const current of contents) if (current.role === entry.role) next.delete(current.id);
    }
    next.add(id);
    shownIds = next;
    publish();
  },
  hide(id: string) {
    if (!shownIds.has(id)) return;
    shownIds = new Set(shownIds);
    shownIds.delete(id);
    publish();
  },
};
const ErrorBoundary = ({children}: {children: React.ReactNode}) => children;
let root: Root | undefined;

function mount() {
  const container = document.getElementById("root");
  if (!container) throw new Error("Navigation resize fixture root is missing.");
  root = createRoot(container);
  const layout = <DefaultLayout store={store as never} widths={widths} active ErrorBoundary={ErrorBoundary as never} />;
  root.render(layout);
}

function unmount() {
  root?.unmount();
  root = undefined;
}

window.__navigationResizeHarness = {
  mount,
  unmount,
  getState: () => ({
    writes: [...configWrites],
    mounts: window.__navigationResizeMounts,
    effectiveWidth: widths.getSnapshot().effectiveWidth,
    shownNavigationId: snapshot.shownIds.find(id => contents.some(entry => entry.id === id && entry.role === "navigation")) ?? null,
  }),
};

class FixtureResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() { this.callback([], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FixtureResizeObserver as unknown as typeof ResizeObserver;
