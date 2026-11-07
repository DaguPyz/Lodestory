import assert from "node:assert/strict";
import test from "node:test";
import {uiPluginFixture} from "./helpers/uiPluginFixture.mjs";

async function setup({guard} = {}) {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  for (const id of ["home", "editor"]) {
    let page;
    await f.core.mount({id, requires: [f.uiKey], provides: [], activate(context) {
      page = context.track(ui.registerPage({id, render: () => null}));
    }, deactivate() {page();}});
  }
  if (guard) await f.core.mount({id: "guard", requires: [f.uiKey], provides: [], activate(context) {
    context.track(ui.registerNavigationGuard({id: "guard", prepare: guard}));
  }});
  await f.notifyReady();
  return {f, ui, root: f.roots[0]};
}

test("removing a visited page keeps the root and unrelated page state", async () => {
  const {f, ui, root} = await setup();
  await ui.openPage("editor", {draft: "preserved"});
  const before = ui.getSnapshot().pages.find(page => page.id === "editor");
  await f.core.unmount("home");
  const after = ui.getSnapshot();
  assert.equal(root.unmountCalls, 0);
  assert.equal(after.current.id, "editor");
  assert.equal(after.pages.length, 1);
  assert.equal(after.pages[0].render, before.render);
  assert.equal(after.pages[0].params, before.params);
});

test("active page is removed only after a guard approves navigation", async () => {
  let allow = false;
  const {f, ui, root} = await setup({guard: () => allow});
  await assert.rejects(f.core.unmount("home"), error => error.phase === "withdraw");
  assert.equal(ui.getSnapshot().current.id, "home");
  assert.equal(f.core.isMounted("home"), true);
  assert.equal(root.unmountCalls, 0);
  allow = true;
  await f.core.unmount("home");
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(root.unmountCalls, 0);
});

test("a second plugin cannot remove the fallback during a pending page withdrawal", async () => {
  let resolveGuard;
  let guardStarted;
  const started = new Promise(resolve => {guardStarted = resolve;});
  const decision = new Promise(resolve => {resolveGuard = resolve;});
  const {f, ui, root} = await setup({guard: () => {guardStarted(); return decision;}});
  const stopping = f.core.unmount("home");
  await started;
  await assert.rejects(f.core.unmount("editor"), /plugins are changing state/);
  resolveGuard(true);
  await stopping;
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(f.core.isMounted("editor"), true);
  assert.equal(root.unmountCalls, 0);
});

test("a root wrapper blocks individual unload before any contribution is withdrawn", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  let page;
  let wrapper;
  await f.core.mount({id: "owner", requires: [f.uiKey], provides: [], activate(context) {
    page = context.track(ui.registerPage({id: "home", render: () => null}));
    wrapper = context.track(ui.addWrapper({id: "fixed", order: 1, wrap: children => children}));
  }, deactivate() {wrapper(); page();}});
  ui.registerPage({id: "other", render: () => null});
  await f.notifyReady();
  await assert.rejects(f.core.unmount("owner"), error => error.phase === "check" && /Root wrapper/.test(error.cause.message));
  assert.equal(ui.getSnapshot().current.id, "home");
  assert.equal(f.roots[0].unmountCalls, 0);
  assert.equal(f.core.isMounted("owner"), true);
});

test("all pages belonging to the same plugin are excluded from the fallback and its guard remains active", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  let allow = false;
  const removers = [];
  await f.core.mount({id: "pages", requires: [f.uiKey], provides: [], activate(context) {
    for (const id of ["one", "two"]) removers.push(context.track(ui.registerPage({id, render: () => null})));
    removers.push(context.track(ui.registerNavigationGuard({id: "owner-guard", prepare: () => allow})));
  }, deactivate() {for (const remove of removers) remove();}});
  await f.core.mount({id: "fallback", requires: [f.uiKey], provides: [], activate(context) {
    context.track(ui.registerPage({id: "fallback", render: () => null}));
  }});
  await f.notifyReady();
  await assert.rejects(f.core.unmount("pages"), error => error.phase === "withdraw");
  assert.equal(ui.getSnapshot().current.id, "one");
  assert.equal(f.roots[0].unmountCalls, 0);
  allow = true;
  await f.core.unmount("pages");
  assert.equal(ui.getSnapshot().current.id, "fallback");
  assert.equal(ui.getSnapshot().pages.some(page => page.id === "one" || page.id === "two"), false);
  assert.equal(f.roots[0].unmountCalls, 0);
});

test("a rejected active-page transition happens before withdrawing the owner's other contributions", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  let otherWithdrawn = false;
  await f.core.mount({id: "owner", requires: [f.uiKey], provides: [], activate(context) {
    context.track(ui.registerPage({id: "one", render: () => null}));
    context.track(ui.registerPage({id: "two", render: () => null}));
    context.track(ui.registerNavigationGuard({id: "veto", prepare: () => false}));
    context.onStop({withdraw() {otherWithdrawn = true;}});
  }});
  ui.registerPage({id: "fallback", render: () => null});
  await f.notifyReady();
  await assert.rejects(f.core.unmount("owner"), error => error.phase === "withdraw");
  assert.equal(otherWithdrawn, false);
  assert.equal(ui.getSnapshot().current.id, "one");
  assert.equal(f.core.isMounted("owner"), true);
});

test("the UI root itself cannot be stopped individually", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  ui.registerPage({id: "home", render: () => null});
  await f.notifyReady();
  await assert.rejects(f.core.unmount("ui"), error => error.phase === "check");
  assert.equal(f.roots[0].unmountCalls, 0);
  await f.core.unmountAll();
  assert.equal(f.roots[0].unmountCalls, 1);
});

test("failed root withdrawal retains the UI service and its dependencies until retry", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  ui.registerPage({id: "home", render: () => null});
  await f.notifyReady();
  f.controls.unmountError = new Error("could not unmount");
  await assert.rejects(f.core.unmountAll(), error => error.pluginId === "ui" && error.phase === "withdraw");
  assert.equal(f.core.isMounted("ui"), true);
  assert.equal(f.core.isMounted("test-config"), true);
  assert.equal(ui.getSnapshot().current.id, "home");
  f.controls.unmountError = null;
  await f.core.unmountAll();
  assert.equal(f.core.isMounted("ui"), false);
  assert.equal(f.roots[0].unmountCalls, 2);
});

test("mutating a page descriptor cannot bypass its active-page leave check", async () => {
  const f = uiPluginFixture();
  const {service: ui} = await f.mountUi();
  const page = {id: "home", render: () => null};
  let remove;
  await f.core.mount({id: "owner", requires: [f.uiKey], provides: [], activate(context) {
    remove = context.track(ui.registerPage(page));
  }, deactivate() {remove();}});
  await f.notifyReady();
  page.id = "different";
  await assert.rejects(f.core.unmount("owner"), error => error.phase === "check");
  assert.equal(ui.getSnapshot().current.id, "home");
  assert.equal(f.roots[0].unmountCalls, 0);
});
