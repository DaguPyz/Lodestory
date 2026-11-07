import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("settings sections can be added after startup and released before their services", () => {
  const fixture = createMainFixture();
  const {createSettingsStore} = fixture.loadModule("plugins/settings/settingsStore.ts");
  const store = createSettingsStore();
  const section = (id, order) => ({id, group: "测试", title: id, order, render: () => id});
  assert.equal(store.service.open(), false);
  assert.throws(() => store.service.registerSection({...section("bad", 0), render: null}));
  assert.equal(store.getSnapshot().sections.length, 0);
  const removeA = store.service.registerSection(section("a", 2));
  const removeB = store.service.registerSection(section("b", 1));
  assert.throws(() => store.service.registerSection(section("a", 0)), /already registered/);
  assert.deepEqual(Array.from(store.getSnapshot().sections, item => item.id), ["b", "a"]);
  store.start();
  const removeLate = store.service.registerSection(section("late", 0));
  assert.ok(store.getSnapshot().sections.some(item => item.id === "late"));
  removeLate();
  assert.equal(store.service.open("unknown"), false);
  assert.equal(store.service.open("a"), true);
  assert.equal(store.getSnapshot().selectedId, "a");
  removeA();
  removeA();
  assert.equal(store.getSnapshot().selectedId, "b");
  assert.equal(store.getSnapshot().open, true);
  assert.ok(fixture.logs.includes("react-dom.flushSync:start"), "active content is withdrawn synchronously");
  removeB();
  assert.equal(store.getSnapshot().open, false, "no orphaned empty dialog remains");
  store.dispose();
  assert.equal(store.service.open(), false);
  assert.throws(() => store.service.registerSection(section("after-stop", 0)), /no longer active/);
});

test("settings plugin registers one shell and an action, and cleans up partial activation", async () => {
  const fixture = createMainFixture();
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {themeKey} = fixture.requireSdk("@lodestory/sdk/theme");
  const {configKey} = fixture.requireSdk("@lodestory/sdk/config");
  const {errorUiKey} = fixture.requireSdk("@lodestory/sdk/error");
  const {navigationLayoutKey} = fixture.requireSdk("@lodestory/sdk/navigation-layout");
  const {settingsKey} = fixture.requireSdk("@lodestory/sdk/settings");
  const plugin = fixture.loadModule("plugins/settings/settingsPlugin.tsx").createSettingsPlugin();
  const events = [];
  let service;
  let wrapper;
  let action;
  const services = new Map([
    [uiKey, {addWrapper(value) { wrapper = value; return () => events.push("unmount"); }}],
    [navigationLayoutKey, {registerAction(value) { action = value; return () => events.push("action removed"); }}],
    [themeKey, {}], [configKey, {}], [errorUiKey, {ErrorBoundary: () => null}],
  ]);
  plugin.activate({get: key => services.get(key), provide(key, value) { assert.equal(key, settingsKey); service = value; }});
  assert.equal(service.open(), false, "the shell waits until startup preparation");
  wrapper.prepare();
  action.run();
  const element = wrapper.wrap("page");
  assert.equal(element.type.name, "SettingsDialog");
  assert.equal(element.props.store.getSnapshot().open, true);
  assert.deepEqual(Array.from(element.props.store.getSnapshot().sections, item => item.id), ["appearance.theme", "appearance.motion"]);
  await plugin.deactivate();
  assert.deepEqual(events, ["unmount", "action removed"]);
  assert.equal(service.open(), false);

  const failed = fixture.loadModule("plugins/settings/settingsPlugin.tsx").createSettingsPlugin();
  services.set(navigationLayoutKey, {registerAction() { throw new Error("action failed"); }});
  assert.throws(() => failed.activate({get: key => services.get(key), provide() {}}), /action failed/);
  await failed.deactivate();
  assert.deepEqual(events, ["unmount", "action removed", "unmount"]);
});
