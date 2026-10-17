import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

const toolbarId = "workbench-toolbar.main";
const entries = [
  {id: "body-editor.main", title: "正文", role: "main"},
  {id: "project-management.files", title: "工程文件", role: "navigation"},
  {id: "editor.auxiliary", title: "参考资料", role: "auxiliary"},
  {id: toolbarId, title: "工作台工具栏", role: "actions"},
  {id: "body-editor.status", title: "写作状态", role: "status"},
];

function createLayout({shownIds = ["body-editor.main", "project-management.files", "editor.auxiliary", toolbarId, "body-editor.status"], extraEntries = []} = {}) {
  let contents = [...entries, ...extraEntries].map(entry => Object.freeze({...entry, render: () => null}));
  let shown = [...shownIds];
  let snapshot = Object.freeze({contents: Object.freeze(contents), shownIds: Object.freeze(shown)});
  const listeners = new Set();
  const calls = [];
  const publish = () => {
    snapshot = Object.freeze({contents: Object.freeze([...contents]), shownIds: Object.freeze([...shown])});
    for (const listener of [...listeners]) listener();
  };
  const layout = {
    calls,
    registerContent() { throw new Error("registration is owned by plugin activation"); },
    show(id) {
      calls.push(["show", id]);
      if (!contents.some(entry => entry.id === id)) throw new Error(`unknown content '${id}'`);
      shown = [...new Set([...shown, id])];
      publish();
    },
    hide(id) {
      calls.push(["hide", id]);
      if (!contents.some(entry => entry.id === id)) throw new Error(`unknown content '${id}'`);
      shown = shown.filter(current => current !== id);
      publish();
    },
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    addContent(id, role) {
      contents = [...contents, Object.freeze({id, title: id, role, render: () => null})];
      publish();
    },
    removeContent(id) {
      contents = contents.filter(entry => entry.id !== id);
      shown = shown.filter(current => current !== id);
      publish();
    },
  };
  return layout;
}

function createWorkbench(session, {active = true, busy = false} = {}) {
  let snapshot = Object.freeze({session, active, busy});
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    service: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async closeProject() { calls.push("closeProject"); return true; },
    },
    set(next) {
      snapshot = Object.freeze({...next});
      for (const listener of [...listeners]) listener();
    },
  };
}

function makeModel(fixture, {session, workbench, layout, ui} = {}) {
  const module = fixture.loadModule("plugins/workbench-toolbar/workbenchToolbarModel.ts");
  const uiCalls = [];
  const actualUi = ui ?? {openPage: async id => { uiCalls.push(id); return true; }};
  const model = module.createWorkbenchToolbarModel(session, workbench.service, actualUi, layout);
  return {model, uiCalls, actualUi};
}

const session = (id = "session-one") => Object.freeze({id, project: Object.freeze({id: `project-${id}`, name: id, path: `/projects/${id}`})});

function expandReactTree(value) {
  if (Array.isArray(value)) return value.map(expandReactTree);
  if (!value || typeof value !== "object") return value;
  if (typeof value.type === "function") return expandReactTree(value.type(value.props ?? {}));
  if (!value.props) return value;
  return {...value, props: {...value.props, children: expandReactTree(value.props.children)}};
}

function collect(value, predicate, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, predicate, found);
  } else if (value && typeof value === "object") {
    if (predicate(value)) found.push(value);
    collect(value.props?.children, predicate, found);
  }
  return found;
}

function textContent(value) {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" ? textContent(value.props?.children) : "";
}

test("focus mode is composed from public layout show and hide operations, with stable model snapshots", () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  assert.equal("setFocusMode" in layout, false);
  const {model} = makeModel(fixture, {session: activeSession, workbench, layout});
  const initial = model.getSnapshot();
  assert.strictEqual(model.getSnapshot(), initial);

  assert.equal(model.enterFocus(), true);
  const focused = model.getSnapshot();
  assert.equal(focused.focusMode, true);
  assert.deepEqual(Array.from(focused.restoreIds), ["project-management.files", "editor.auxiliary"]);
  assert.deepEqual(layout.calls, [["hide", "project-management.files"], ["hide", "editor.auxiliary"]]);
  assert.equal(layout.getSnapshot().shownIds.includes("body-editor.main"), true);
  assert.equal(layout.getSnapshot().shownIds.includes(toolbarId), true);
  assert.strictEqual(model.getSnapshot(), focused, "repeated reads reuse the immutable state object");

  assert.equal(model.exitFocus(), true);
  assert.equal(model.getSnapshot().focusMode, false);
  assert.deepEqual(Array.from(model.getSnapshot().restoreIds), []);
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"));
  assert.ok(layout.getSnapshot().shownIds.includes("editor.auxiliary"));
  model.dispose();
});

test("focus restores only still-registered panels and an external panel show ends focus without overriding it", () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  const {model} = makeModel(fixture, {session: activeSession, workbench, layout});
  model.enterFocus();
  layout.removeContent("editor.auxiliary");
  assert.equal(model.exitFocus(), true);
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"));
  assert.ok(!layout.calls.some(([operation, id]) => operation === "show" && id === "editor.auxiliary"));

  model.enterFocus();
  layout.addContent("search.navigation", "navigation");
  layout.show("search.navigation");
  assert.equal(model.getSnapshot().focusMode, false);
  assert.deepEqual(Array.from(model.getSnapshot().restoreIds), []);
  assert.ok(layout.getSnapshot().shownIds.includes("search.navigation"));
  assert.ok(!layout.getSnapshot().shownIds.includes("project-management.files"), "focus exit respects a new panel choice rather than restoring stale panels");
  model.dispose();
});

test("panel toggles leave focus first, while main and status toggles do not change focus state", () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  const {model} = makeModel(fixture, {session: activeSession, workbench, layout});
  model.enterFocus();
  assert.equal(model.toggleContent("body-editor.status"), true);
  assert.equal(model.getSnapshot().focusMode, true);
  assert.equal(model.toggleContent("body-editor.main"), true);
  assert.equal(model.getSnapshot().focusMode, true);
  assert.equal(model.toggleContent("project-management.files"), true);
  assert.equal(model.getSnapshot().focusMode, false);
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"));
  model.dispose();
});

test("busy, inactive, stale-session, and hidden-toolbar states block toolbar actions; recovery can show the toolbar", async () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  const uiCalls = [];
  const {model} = makeModel(fixture, {
    session: activeSession, workbench, layout,
    ui: {openPage: async id => { uiCalls.push(id); return true; }},
  });

  layout.hide(toolbarId);
  assert.equal(model.enterFocus(), false);
  assert.equal(model.toggleContent("project-management.files"), false);
  assert.equal(await model.openSettings(), false);
  assert.equal(await model.leaveProject(), false);
  assert.equal(model.showToolbar(), true);
  assert.ok(layout.getSnapshot().shownIds.includes(toolbarId));

  const before = layout.calls.length;
  workbench.set({session: activeSession, active: true, busy: true});
  assert.equal(model.enterFocus(), false);
  assert.equal(model.showToolbar(), false);
  assert.equal(await model.openSettings(), false);
  assert.equal(layout.calls.length, before);
  assert.deepEqual(uiCalls, []);

  workbench.set({session: activeSession, active: false, busy: false});
  assert.equal(model.enterFocus(), false);
  assert.equal(await model.openSettings(), false);
  workbench.set({session: session("other-session"), active: true, busy: false});
  assert.equal(model.enterFocus(), false);
  assert.equal(await model.leaveProject(), false);
  assert.deepEqual(workbench.calls, []);
  model.dispose();
});

test("workbench actions use the existing close-project and UI navigation APIs", async () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  const uiCalls = [];
  const {model} = makeModel(fixture, {
    session: activeSession, workbench, layout,
    ui: {openPage: async (id, ...args) => { uiCalls.push([id, ...args]); return true; }},
  });
  assert.equal(await model.openSettings(), true);
  assert.deepEqual(uiCalls, [["settings"]]);
  assert.equal(await model.leaveProject(), true);
  assert.deepEqual(workbench.calls, ["closeProject"]);
  model.dispose();
});

test("toolbar UI exposes project actions, layout toggles, focus, and disabled search", async () => {
  const fixture = createMainFixture({mockWorkbenchToolbar: false});
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout();
  const uiCalls = [];
  const {model} = makeModel(fixture, {
    session: activeSession,
    workbench,
    layout,
    ui: {openPage: async id => { uiCalls.push(id); return true; }},
  });
  const {WorkbenchToolbar} = fixture.loadModule("plugins/workbench-toolbar/WorkbenchToolbar.tsx");
  const tree = expandReactTree(WorkbenchToolbar({
    workbench: workbench.service,
    layout,
    models: new Map([[activeSession.id, model]]),
    active: true,
  }));
  const buttons = collect(tree, value => value.type === "button");
  const button = (labelOrText) => buttons.find(value => value.props["aria-label"] === labelOrText || textContent(value) === labelOrText);
  assert.ok(collect(tree, value => value.props?.className === "toolbar-brand").length);
  assert.ok(collect(tree, value => value.props?.className === "toolbar-project-trigger").some(value => textContent(value).includes(activeSession.project.name)));
  assert.equal(button("搜索项目").props.disabled, true);
  assert.ok(button("设置"), "the common settings entry is available");
  assert.ok(button("工程文件"), "navigation contents receive their own toolbar toggles");
  assert.ok(button("收起参考资料"), "auxiliary contents receive their own toolbar toggles");
  assert.ok(button("专注模式"), "focus mode is owned by the toolbar");
  assert.ok(collect(tree, value => value.props?.["aria-label"] === "布局内容").length, "the full layout directory remains available");
  assert.ok(button("返回欢迎页"));
  assert.ok(button("外观设置"));

  button("专注模式").props.onClick();
  assert.equal(model.getSnapshot().focusMode, true);
  button("工程文件").props.onClick();
  assert.equal(model.getSnapshot().focusMode, false);
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"));
  button("设置").props.onClick();
  button("返回欢迎页").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uiCalls, ["settings"]);
  assert.deepEqual(workbench.calls, ["closeProject"]);
  model.dispose();
});

test("toolbar plugin registers its actions content and independent recovery wrapper, and cleans partial activation", async () => {
  const fixture = createMainFixture();
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const registrations = [];
  const removals = [];
  const participants = [];
  const wrappers = [];
  const layout = {
    registerContent(entry) {
      registrations.push(entry);
      return () => removals.push(entry.id);
    },
    show() {}, hide() {}, getSnapshot: () => ({contents: [], shownIds: []}), subscribe: () => () => {},
  };
  const workbench = {registerParticipant(entry) { participants.push(entry); return async () => { removals.push("participant"); }; }};
  const ui = {
    addWrapper(entry) { wrappers.push(entry); throw new Error("wrapper registration failed"); },
  };
  const plugin = fixture.loadModule("plugins/workbench-toolbar/workbenchToolbarPlugin.tsx").createWorkbenchToolbarPlugin();
  assert.equal(plugin.id, "workbench-toolbar");
  assert.deepEqual(Array.from(plugin.requires, key => key.id), ["app/workbench", "app/ui", "app/layout"]);
  assert.deepEqual(Array.from(plugin.provides), []);
  assert.throws(() => plugin.activate({get(key) {
    if (key === workbenchKey) return workbench;
    if (key === uiKey) return ui;
    if (key === layoutKey) return layout;
  }}), /wrapper registration failed/);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, toolbarId);
  assert.equal(registrations[0].role, "actions");
  assert.equal(participants[0].id, "workbench-toolbar");
  assert.equal(wrappers[0].id, "workbench-toolbar.recovery");
  await plugin.deactivate();
  await plugin.deactivate();
  assert.deepEqual(removals, [toolbarId, "participant"]);
});

test("the UI wrapper keeps a separate recovery component that calls the session model", () => {
  const fixture = createMainFixture();
  const activeSession = session();
  const workbench = createWorkbench(activeSession);
  const layout = createLayout({shownIds: ["body-editor.main"]});
  const plugin = fixture.loadModule("plugins/workbench-toolbar/workbenchToolbarPlugin.tsx").createWorkbenchToolbarPlugin();
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  let wrapper;
  let participant;
  const ui = {addWrapper(value) { wrapper = value; return () => {}; }};
  const registered = [];
  layout.registerContent = entry => { registered.push(entry); return () => {}; };
  const service = {...workbench.service, registerParticipant(value) { participant = value; return async () => {}; }};
  plugin.activate({get(key) {
    if (key === workbenchKey) return service;
    if (key === uiKey) return ui;
    if (key === layoutKey) return layout;
  }});
  const participation = participant.start(activeSession);
  const toolbarElement = registered[0].render({active: true});
  const model = toolbarElement.props.models.get(activeSession.id);
  const wrapped = wrapper.wrap("page-root");
  const recoveryElement = Array.isArray(wrapped.props.children) ? wrapped.props.children.at(-1) : wrapped.props.children;
  assert.equal(recoveryElement.type, fixture.components.ToolbarRecovery);
  const recoveryView = recoveryElement.type(recoveryElement.props);
  assert.strictEqual(recoveryView.props.model, model);
  assert.equal(recoveryView.props.model.showToolbar(), true);
  assert.ok(layout.getSnapshot().shownIds.includes(toolbarId));
  participation.dispose();
  return plugin.deactivate();
});

test("each workbench session owns a separate toolbar model and stale models cannot act", async () => {
  const fixture = createMainFixture();
  const first = session("first");
  const second = session("second");
  const workbench = createWorkbench(first);
  const layout = createLayout();
  const plugin = fixture.loadModule("plugins/workbench-toolbar/workbenchToolbarPlugin.tsx").createWorkbenchToolbarPlugin();
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  let participant;
  const registered = [];
  layout.registerContent = entry => { registered.push(entry); return () => {}; };
  plugin.activate({get(key) {
    if (key === workbenchKey) return {...workbench.service, registerParticipant(value) { participant = value; return async () => {}; }};
    if (key === uiKey) return {openPage: async () => true, addWrapper: () => () => {}};
    if (key === layoutKey) return layout;
  }});
  const firstResources = participant.start(first);
  const modelFor = id => registered[0].render({active: true}).props.models.get(id);
  const firstModel = modelFor(first.id);
  assert.equal(firstModel.enterFocus(), true);
  const secondResources = participant.start(second);
  const secondModel = modelFor(second.id);
  workbench.set({session: second, active: true, busy: false});
  await firstResources.dispose();
  assert.equal(layout.getSnapshot().shownIds.includes("project-management.files"), true, "disposing the old session restores its temporarily hidden panel");
  assert.equal(firstModel.enterFocus(), false, "a model from the previous session cannot act on the current project");
  assert.equal(secondModel.enterFocus(), true, "the current session gets its own active focus state");
  await secondResources.dispose();
  await plugin.deactivate();
});

test("public layout SDK keeps only generic visibility contracts", () => {
  const source = readFileSync(new URL("../packages/sdk/src/layout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:focusMode|setFocusMode|hideable)\b/);
  const layout = createLayout();
  assert.equal(typeof layout.show, "function");
  assert.equal(typeof layout.hide, "function");
  assert.equal(typeof layout.getSnapshot, "function");
  assert.equal("setFocusMode" in layout, false);
  assert.equal("hideable" in layout, false);
});
