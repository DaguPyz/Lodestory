import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function registry() {
  const f = createMainFixture();
  let removals = 0;
  const store = f.loadModule("plugins/default-layout/layoutStore.ts").createLayoutStore(() => removals++);
  return {f, store, removals: () => removals};
}

test("default layout registers its persisted navigation width with the configuration service", async () => {
  const f = createMainFixture({configOverrides: {"defaultLayout.navigationWidth": 480}});
  f.start();
  await flushStartup();

  const {configKey} = f.requireSdk("@lodestory/sdk/config");
  const {navigationWidthConfig} = f.loadModule("plugins/default-layout/navigationWidth.ts");
  const config = f.getService(configKey);
  assert.equal(config.getSnapshot(navigationWidthConfig), 480,
    "the default-layout plugin declares the saved preference through the configuration service");

  await f.createdCores.at(-1).unmountAll();
});
const content = (id, role = "main", order = 0) => ({id, title: id, role, order, render: ({active}) => ({id, active})});
const ids = store => Array.from(store.getSnapshot().shownIds);

test("layout descriptions are snapshotted, sorted independently of registration order, and never rendered on registration", () => {
  const {store} = registry();
  let renders = 0;
  const icon = Object.freeze({type: "layout-icon-probe"});
  const input = {...content("z", "navigation"), icon, render: () => { renders++; }};
  store.registerContent(input);
  store.registerContent(content("a", "navigation"));
  store.registerContent(content("first", "navigation", -1));
  store.registerContent(content("main"));
  input.id = "mutated";
  input.order = -100;
  input.icon = null;
  input.render = null;
  assert.equal(renders, 0);
  assert.deepEqual(ids(store), []);
  assert.deepEqual(Array.from(store.getSnapshot().contents, entry => entry.id), ["main", "first", "a", "z"]);
  assert.equal(typeof store.getSnapshot().contents[3].render, "function");
  assert.strictEqual(store.getSnapshot().contents[3].icon, icon, "optional icons survive the layout snapshot independently of the caller's descriptor");
  assert.ok(Object.isFrozen(store.getSnapshot()));
  assert.ok(Object.isFrozen(store.getSnapshot().contents));
  assert.ok(Object.isFrozen(store.getSnapshot().contents[0]));
  store.start();
  assert.deepEqual(ids(store), ["main", "first"]);
  assert.equal(renders, 0);
});

test("layout rejects malformed and duplicate registrations atomically and seals additions at ready", () => {
  const {store} = registry();
  store.registerContent(content("valid"));
  const snapshot = store.getSnapshot();
  for (const bad of [{id: ""}, {title: " "}, {role: "left"}, {order: NaN}, {order: Infinity}, {render: null}]) {
    assert.throws(() => store.registerContent({...content("invalid"), ...bad}));
    assert.equal(store.getSnapshot(), snapshot);
  }
  assert.throws(() => store.registerContent(content("valid")), /already registered/);
  assert.throws(() => store.show("valid"), /not ready/);
  store.start();
  assert.throws(() => store.registerContent(content("late")), /before pluginsReady/);
  assert.throws(() => store.show("missing"), /not registered/);
  assert.throws(() => store.hide("missing"), /not registered/);
});

test("show and hide select by ID across all roles without losing descriptors or notifying on no-ops", () => {
  const {store} = registry();
  for (const role of ["main", "navigation", "auxiliary", "actions", "status"]) {
    store.registerContent(content(`${role}.a`, role));
    store.registerContent(content(`${role}.b`, role));
  }
  store.start();
  let changes = 0;
  const stop = store.subscribe(() => changes++);
  const before = store.getSnapshot();
  store.show("main.a");
  assert.equal(store.getSnapshot(), before);
  assert.equal(changes, 0);
  store.show("main.b");
  assert.ok(!ids(store).includes("main.a"));
  store.hide("main.b");
  assert.equal(store.getSnapshot().contents.length, 10);
  for (const role of ["main", "navigation", "auxiliary", "actions", "status"]) {
    store.show(`${role}.b`);
    assert.ok(ids(store).includes(`${role}.b`));
    store.hide(`${role}.b`);
    assert.ok(!ids(store).includes(`${role}.b`));
    store.show(`${role}.b`);
  }
  stop(); stop();
  const previousChanges = changes;
  store.hide("status.b");
  assert.equal(changes, previousChanges);
});

test("responsive panels and main activation retain choices while preventing overlapping drawers", () => {
  const {store} = registry();
  for (const role of ["main", "navigation", "auxiliary", "actions", "status"]) store.registerContent(content(role, role));
  store.setViewport(400, 16);
  store.start();
  assert.deepEqual(ids(store), ["main", "actions", "status"]);
  store.show("navigation");
  assert.ok(ids(store).includes("navigation"));
  store.show("auxiliary");
  assert.ok(!ids(store).includes("navigation"));
  assert.ok(ids(store).includes("auxiliary"));
  store.show("main");
  assert.ok(!ids(store).includes("auxiliary"));
  store.setViewport(1400, 16);
  store.show("navigation");
  store.show("auxiliary");
  assert.ok(ids(store).includes("navigation") && ids(store).includes("auxiliary"));
  store.show("navigation");
  store.setViewport(600, 16);
  assert.ok(ids(store).includes("navigation"));
  assert.ok(!ids(store).includes("auxiliary"));
  store.hide("navigation");
  store.setViewport(1600, 16);
  assert.ok(!ids(store).includes("navigation"), "an explicit hide survives resizing");
});

test("disposers are idempotent and stale-safe, and stop rendering before revoking a live contribution", () => {
  const {store, removals} = registry();
  const old = store.registerContent(content("replace"));
  old();
  const fresh = store.registerContent(content("replace"));
  old();
  assert.equal(store.getSnapshot().contents.length, 1);
  assert.equal(removals(), 0);
  store.start();
  fresh(); fresh();
  assert.equal(removals(), 1);
  assert.equal(store.getSnapshot().contents.length, 0);
  store.dispose(); store.dispose(); old();
  assert.throws(() => store.getSnapshot(), /no longer active/);
  assert.throws(() => store.subscribe(() => {}), /no longer active/);
});

test("layout cleanup still revokes a descriptor when stopping UI fails", () => {
  const f = createMainFixture();
  const store = f.loadModule("plugins/default-layout/layoutStore.ts").createLayoutStore(() => { throw new Error("stop failed"); });
  const remove = store.registerContent(content("one"));
  store.start();
  assert.throws(remove, /stop failed/);
  assert.equal(store.getSnapshot().contents.length, 0);
  remove();
});

test("outline navigation switches independently while preserving editor contents and the workbench session", async () => {
  const f = createMainFixture();
  f.start(); await flushStartup();
  const layoutKey = f.requireSdk("@lodestory/sdk/layout").layoutKey;
  const workbenchKey = f.requireSdk("@lodestory/sdk/workbench").workbenchKey;
  const layout = f.getService(layoutKey);
  const workbench = f.getService(workbenchKey);
  assert.deepEqual(Array.from(layout.getSnapshot().contents, entry => entry.role), ["main", "tabs", "navigation", "navigation", "actions", "status"]);
  assert.ok(layout.getSnapshot().contents.some(({id}) => id === "project-management.files"));
  const outline = layout.getSnapshot().contents.find(({id}) => id === "outline-design.navigation");
  assert.ok(outline, "the outline-design plugin contributes through the layout service");
  assert.ok(outline.icon, "the outline navigation contribution provides its own icon");
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"), "project files remain the initially selected navigation contribution");
  assert.ok(!layout.getSnapshot().shownIds.includes(outline.id));
  assert.deepEqual(Array.from(layout.getSnapshot().contents, entry => entry.id).sort(), [
    "body-editor.main", "document-tabs.tabs", "outline-design.navigation", "project-management.files", "workbench-toolbar.main", "writing-status.status",
  ]);
  assert.ok(f.lifecycle.indexOf("activate:default-layout:complete") < f.lifecycle.indexOf("activate:body-editor:begin"));
  assert.ok(f.lifecycle.indexOf("activate:project-management:complete") < f.lifecycle.indexOf("activate:body-editor:begin"));
  assert.ok(f.lifecycle.indexOf("activate:body-editor:complete") < f.lifecycle.indexOf("activate:workbench-toolbar:begin"));
  const editorContentIds = ["document-tabs.tabs", "body-editor.main", "writing-status.status"];
  for (const hiddenId of editorContentIds) {
    layout.hide(hiddenId);
    const shownIds = new Set(layout.getSnapshot().shownIds);
    assert.equal(shownIds.has(hiddenId), false, `${hiddenId} should be hidden independently`);
    for (const otherId of editorContentIds) {
      if (otherId !== hiddenId) assert.equal(shownIds.has(otherId), true, `${otherId} should stay visible`);
    }
    layout.show(hiddenId);
  }
  const ui = f.getService(f.requireSdk("@lodestory/sdk/ui").uiKey);
  await ui.openPage("editor", {project: {id: "one", name: "one", path: "/one"}});
  const session = workbench.getSnapshot().session;
  assert.ok(session, "opening the editor establishes a workbench session");
  const editorContents = ["body-editor.main", "document-tabs.tabs"];
  for (const id of editorContents) assert.ok(layout.getSnapshot().shownIds.includes(id), `${id} starts visible`);
  layout.show(outline.id);
  assert.ok(layout.getSnapshot().shownIds.includes(outline.id));
  assert.ok(!layout.getSnapshot().shownIds.includes("project-management.files"));
  for (const id of editorContents) assert.ok(layout.getSnapshot().shownIds.includes(id), `${id} stays visible when opening the outline`);
  assert.strictEqual(workbench.getSnapshot().session, session, "switching to the outline retains the same workbench session");
  layout.show("project-management.files");
  assert.ok(layout.getSnapshot().shownIds.includes("project-management.files"));
  assert.ok(!layout.getSnapshot().shownIds.includes(outline.id));
  for (const id of editorContents) assert.ok(layout.getSnapshot().shownIds.includes(id), `${id} stays visible when returning to project files`);
  assert.strictEqual(workbench.getSnapshot().session, session, "returning to project files retains the same workbench session");
  await ui.openPage("settings"); await ui.back();
  assert.equal(layout.getSnapshot().shownIds.includes("project-management.files"), true, "page navigation does not reset layout selection");
  assert.equal(layout.getSnapshot().shownIds.includes(outline.id), false);
  assert.strictEqual(workbench.getSnapshot().session, session, "temporary page navigation retains the current project session");
  await f.createdCores.at(-1).unmount("outline-design");
  assert.ok(!layout.getSnapshot().contents.some(({id}) => id === outline.id), "unmounting outline-design revokes its contribution");
  assert.ok(layout.getSnapshot().contents.some(({id}) => id === "project-management.files"), "revoking the outline leaves the project-files contribution registered");
  await f.createdCores.at(-1).unmount("workbench-toolbar");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id).sort(), [
    "body-editor.main", "document-tabs.tabs", "project-management.files", "writing-status.status",
  ]);
  await f.createdCores.at(-1).unmount("writing-status");
  await f.createdCores.at(-1).unmount("rich-text-editor");
  await f.createdCores.at(-1).unmount("markdown-editor");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id).sort(), [
    "body-editor.main", "document-tabs.tabs", "project-management.files",
  ]);
  await f.createdCores.at(-1).unmount("body-editor");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id).sort(), [
    "document-tabs.tabs", "project-management.files",
  ]);
  await f.createdCores.at(-1).unmount("project-management");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id), ["document-tabs.tabs"]);
  await f.createdCores.at(-1).unmount("document-tabs");
  assert.equal(layout.getSnapshot().contents.length, 0);
  assert.equal(f.logs.filter(entry => entry === "root.unmount").length, 1);
  await f.createdCores.at(-1).unmountAll();
  assert.throws(() => layout.getSnapshot(), /no longer active/);
  assert.equal(f.logs.filter(entry => entry === "root.unmount").length, 1);
});

test("another provider of layoutKey receives the editor contributions and is injected into the editor page", async () => {
  const contributions = [];
  const removed = [];
  const listeners = new Set();
  let contents = [];
  let snapshot = Object.freeze({contents: Object.freeze([]), shownIds: Object.freeze([])});
  const publish = () => {
    snapshot = Object.freeze({contents: Object.freeze([...contents]), shownIds: snapshot.shownIds});
    for (const listener of [...listeners]) listener();
  };
  const service = {
    View: function OtherLayout() {},
    registerContent(entry) {
      contributions.push(entry);
      contents = [...contents, entry];
      publish();
      return () => {
        removed.push(entry.id);
        contents = contents.filter(current => current !== entry);
        publish();
      };
    },
    show(id) {
      if (!contents.some(entry => entry.id === id)) throw new Error(`Layout content '${id}' is not registered.`);
      snapshot = Object.freeze({contents: Object.freeze([...contents]), shownIds: Object.freeze([...new Set([...snapshot.shownIds, id])])});
      for (const listener of [...listeners]) listener();
    },
    hide(id) {
      if (!contents.some(entry => entry.id === id)) throw new Error(`Layout content '${id}' is not registered.`);
      snapshot = Object.freeze({contents: Object.freeze([...contents]), shownIds: Object.freeze(snapshot.shownIds.filter(current => current !== id))});
      for (const listener of [...listeners]) listener();
    },
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const f = createMainFixture({layoutFactory: ({layoutKey}) => ({
    id: "other-layout", requires: [], provides: [layoutKey],
    activate(context) { context.provide(layoutKey, service); },
  })});
  f.start(); await flushStartup();
assert.equal(contributions.length, 6);
  assert.deepEqual(contributions.map(({id}) => id).sort(), [
  "body-editor.main", "document-tabs.tabs", "outline-design.navigation", "project-management.files", "workbench-toolbar.main", "writing-status.status",
  ]);
  const ui = f.getService(f.requireSdk("@lodestory/sdk/ui").uiKey);
  await ui.openPage("editor", {project: {id: "test", name: "test", path: "/test"}});
  const page = ui.getSnapshot().pages.find(page => page.id === "editor");
  const boundary = page.render(page);
  const shell = boundary.props.children;
  const workbenchPage = shell.props.children;
  assert.equal(workbenchPage.type, f.components.WorkbenchPage);
  assert.equal(workbenchPage.props.layout, service);
  assert.equal(workbenchPage.props.layout.View, service.View);
  await f.createdCores.at(-1).unmountAll();
assert.equal(new Set(removed).size, 6);
});
