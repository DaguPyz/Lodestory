import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

test("the application bridge registers nested interactions and releases them when stopped", () => {
  const fixture = createMainFixture();
  const {uiKey, uiInteractionKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const plugin = fixture.loadModule("plugins/ui-interaction/uiInteractionPlugin.tsx").createUiInteractionPlugin();
  const registrations = new Set();
  const events = [];
  let wrapper;
  let service;
  const ui = {
    addWrapper(value) { wrapper = value; return () => events.push("unmount"); },
    registerOverlay(element) {
      registrations.add(element);
      return () => { events.push("release"); registrations.delete(element); };
    },
    hasActiveOverlay: () => registrations.size > 0,
  };
  plugin.activate({
    track: value => value,
    get(key) { assert.equal(key, uiKey); return ui; },
    provide(key, value) { assert.equal(key, uiInteractionKey); service = value; },
  });
  assert.deepEqual(Array.from(plugin.requires, key => key.id), ["app/ui"]);
  const root = wrapper.wrap("root");
  const separateRoot = service.wrap("toolbar");
  assert.equal(root.type.name, "InteractionProvider");
  assert.strictEqual(root.props.onActivate, separateRoot.props.onActivate);
  const onActivate = root.props.onActivate;
  const outer = onActivate({element: {id: "outer"}, kind: "dialog"});
  const inner = onActivate({element: {id: "inner"}, kind: "select"});
  assert.equal(registrations.size, 2);
  assert.equal(service.hasActiveOverlay(), true);
  inner();
  inner();
  assert.equal(registrations.size, 1, "closing a nested popup keeps its parent active");
  outer();
  assert.equal(service.hasActiveOverlay(), false);
  const releaseAfterStop = onActivate({element: {id: "during-stop"}, kind: "menu"});
  events.length = 0;
  plugin.deactivate();
  assert.deepEqual(events, ["unmount", "release"]);
  assert.equal(registrations.size, 0);
  assert.equal(service.hasActiveOverlay(), false);
  releaseAfterStop();
  onActivate({element: {id: "after-stop"}, kind: "menu"})();
  assert.equal(registrations.size, 0);
});

test("a failed wrapper registration can release partially created interactions", () => {
  const fixture = createMainFixture();
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const plugin = fixture.loadModule("plugins/ui-interaction/uiInteractionPlugin.tsx").createUiInteractionPlugin();
  const registrations = new Set();
  const ui = {
    registerOverlay(element) { registrations.add(element); return () => registrations.delete(element); },
    hasActiveOverlay: () => registrations.size > 0,
    addWrapper(wrapper) {
      wrapper.wrap(null).props.onActivate({element: {id: "partial"}, kind: "dialog"});
      throw new Error("registration failed");
    },
  };
  assert.throws(() => plugin.activate({
    track: value => value,
    get(key) { assert.equal(key, uiKey); return ui; },
    provide() {},
  }), /registration failed/);
  assert.equal(registrations.size, 1);
  plugin.deactivate();
  assert.equal(registrations.size, 0);
});
