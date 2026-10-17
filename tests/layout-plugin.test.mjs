import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function registry() {
  const f = createMainFixture();
  let removals = 0;
  const store = f.loadModule("plugins/default-layout/layoutStore.ts").createLayoutStore(() => removals++);
  return {f, store, removals: () => removals};
}
const content = (id, role = "main", order = 0) => ({id, title: id, role, order, render: ({active}) => ({id, active})});
const ids = store => Array.from(store.getSnapshot().shownIds);

test("layout descriptions are snapshotted, sorted independently of registration order, and never rendered on registration", () => {
  const {store} = registry();
  let renders = 0;
  const input = {...content("z", "navigation"), render: () => { renders++; }};
  store.registerContent(input);
  store.registerContent(content("a", "navigation"));
  store.registerContent(content("first", "navigation", -1));
  store.registerContent(content("main"));
  input.id = "mutated";
  input.order = -100;
  input.render = null;
  assert.equal(renders, 0);
  assert.deepEqual(ids(store), []);
  assert.deepEqual(Array.from(store.getSnapshot().contents, entry => entry.id), ["main", "first", "a", "z"]);
  assert.equal(typeof store.getSnapshot().contents[3].render, "function");
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

test("project management, body editor, and workbench toolbar contribute their own layout roles", async () => {
  const f = createMainFixture();
  f.start(); await flushStartup();
  const layoutKey = f.requireSdk("@lodestory/sdk/layout").layoutKey;
  const layout = f.getService(layoutKey);
  assert.deepEqual(Array.from(layout.getSnapshot().contents, entry => entry.role), ["main", "navigation", "actions", "status"]);
  assert.ok(layout.getSnapshot().contents.some(({id}) => id === "project-management.files"));
  assert.deepEqual(Array.from(layout.getSnapshot().contents, entry => entry.id).sort(), [
    "body-editor.main", "body-editor.status", "project-management.files", "workbench-toolbar.main",
  ]);
  assert.ok(f.lifecycle.indexOf("activate:default-layout:complete") < f.lifecycle.indexOf("activate:body-editor:begin"));
  assert.ok(f.lifecycle.indexOf("activate:project-management:complete") < f.lifecycle.indexOf("activate:body-editor:begin"));
  assert.ok(f.lifecycle.indexOf("activate:body-editor:complete") < f.lifecycle.indexOf("activate:workbench-toolbar:begin"));
  const before = layout.getSnapshot();
  const ui = f.getService(f.requireSdk("@lodestory/sdk/ui").uiKey);
  await ui.openPage("editor", {project: {id: "one", name: "one", path: "/one"}});
  await ui.openPage("settings"); await ui.back();
  assert.equal(layout.getSnapshot(), before, "page navigation does not reset layout selection");
  await f.createdCores.at(-1).unmount("workbench-toolbar");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id).sort(), [
    "body-editor.main", "body-editor.status", "project-management.files",
  ]);
  await f.createdCores.at(-1).unmount("body-editor");
  assert.deepEqual(Array.from(layout.getSnapshot().contents, ({id}) => id), ["project-management.files"]);
  await f.createdCores.at(-1).unmount("project-management");
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
  assert.equal(contributions.length, 4);
  assert.deepEqual(contributions.map(({id}) => id).sort(), [
    "body-editor.main", "body-editor.status", "project-management.files", "workbench-toolbar.main",
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
  assert.equal(new Set(removed).size, 4);
});
