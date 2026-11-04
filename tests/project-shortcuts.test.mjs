import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function setup({bindingCleanupError} = {}) {
  let indexDisposed = false;
  const index = {dispose() { indexDisposed = true; }};
  const displayedRequests = [];
  const fixture = createMainFixture({moduleMocks: {
    "./searchIndex": {createSearchIndex: () => index},
    "./ProjectSearch": {ProjectSearch({requests}) { requests.subscribe(sessionId => displayedRequests.push(sessionId)); return null; }},
  }});
  const {projectSearchKey, projectSearchRequested} = fixture.requireSdk("@lodestory/sdk/project-search");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {workbenchKey} = fixture.requireSdk("@lodestory/sdk/workbench");
  const {shortcutsKey, shortcutCommandIds, shortcutScopeIds} = fixture.requireSdk("@lodestory/sdk/shortcuts");
  const session = {id: "project-session"};
  let snapshot = {session, active: true, busy: false};
  const commands = new Map(), bindings = new Map(), listeners = new Map(), wrappers = [];
  const subscribers = new Set();
  const shortcuts = {
    registerCommand(command) { commands.set(command.id, command); return () => commands.delete(command.id); },
    registerBinding(binding) {
      bindings.set(binding.id, binding);
      return () => {
        bindings.delete(binding.id);
        if (bindingCleanupError) throw bindingCleanupError;
      };
    },
    registerScope() { return () => {}; },
    async execute(id, args, source = "ui", target = null) {
      const command = commands.get(id);
      if (!command) return false;
      const invocation = {source, target, args};
      if (command.enabled && !command.enabled(invocation)) return false;
      await command.run(invocation);
      return true;
    },
    getShortcut(id) { return [...bindings.values()].find(binding => binding.commandId === id)?.keys; },
    getSnapshot() { return {commands: [], bindings: [], conflicts: []}; },
    subscribe() { return () => {}; },
    async setBinding() {}, async resetBinding() {},
  };
  const ui = {addWrapper(wrapper) { wrappers.push(wrapper); return () => wrappers.splice(wrappers.indexOf(wrapper), 1); }};
  const workbench = {getSnapshot() { return snapshot; }};
  const events = new Map(), removedEvents = [];
  const context = {
    provide(key, service) { if (key === projectSearchKey) providedSearch = service; },
    get(key) {
      if (key === uiKey) return ui;
      if (key === workbenchKey) return workbench;
      if (key === shortcutsKey) return shortcuts;
      throw new Error(`Unexpected service '${key.id}'.`);
    },
    on(key, listener) { if (!events.has(key)) events.set(key, new Set()); events.get(key).add(listener); return () => { events.get(key).delete(listener); removedEvents.push(key); }; },
    async emit(key, value) { await Promise.all([...(events.get(key) ?? [])].map(listener => listener(value))); },
  };
  let providedSearch;
  const plugin = fixture.loadModule("plugins/project-search/projectSearchPlugin.tsx").createProjectSearchPlugin();
  return {bindings, commands, context, events, fixture, indexDisposed: () => indexDisposed,
    displayedRequests, projectSearchRequested, projectSearchKey, providedSearch: () => providedSearch, plugin, removedEvents,
    session, setSnapshot(value) { snapshot = {...snapshot, ...value}; }, shortcutCommandIds, shortcutScopeIds,
    shortcuts, wrappers};
}

function findNamed(value, name) {
  if (!value || typeof value !== "object") return undefined;
  if (value.type?.name === name) return value;
  const children = value.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findNamed(child, name);
    if (found) return found;
  }
}

test("project search exposes an input-enabled shortcut and routes stale-session requests through its command", async () => {
  const f = setup();
  f.plugin.activate(f.context);
  assert.ok(f.providedSearch());
  const binding = f.bindings.get("project-search.open");
  assert.equal(binding.keys, "Mod+Shift+F");
  assert.equal(binding.scopeId, f.shortcutScopeIds.workbench);
  assert.equal(binding.allowInInput, true);

  const searchElement = findNamed(f.wrappers[0].wrap("pages"), "ProjectSearch");
  assert.ok(searchElement);
  searchElement.type(searchElement.props);
  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.projectSearch, undefined, "keyboard", {tagName: "INPUT"}), true,
    "search can be invoked from an input without event payload data");
  assert.deepEqual(f.displayedRequests, [f.session.id]);

  assert.equal(await f.shortcuts.execute(f.shortcutCommandIds.projectSearch, {sessionId: "old-session"}), false,
    "a stale session cannot open project search");
  await f.context.emit(f.projectSearchRequested, {sessionId: "old-session"});
  assert.equal(f.displayedRequests.length, 1);
  await f.context.emit(f.projectSearchRequested, {sessionId: f.session.id});
  assert.equal(f.displayedRequests.length, 2, "the public request follows the same command path and checks the current session");
  await f.plugin.deactivate();
  assert.equal(f.commands.size, 0);
  assert.equal(f.bindings.size, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.indexDisposed(), true);
});

test("project search deactivation attempts every cleanup after a binding cleanup failure", async () => {
  const f = setup({bindingCleanupError: new Error("binding cleanup failed")});
  f.plugin.activate(f.context);
  assert.throws(() => f.plugin.deactivate(), /Project search failed to stop/);
  assert.equal(f.commands.size, 0, "command registration was removed despite the binding error");
  assert.equal(f.bindings.size, 0);
  assert.equal(f.wrappers.length, 0);
  assert.equal(f.removedEvents.length, 1);
  assert.equal(f.indexDisposed(), true, "search index disposal still runs after earlier cleanup errors");
});
