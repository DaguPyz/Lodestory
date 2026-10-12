import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = fileURLToPath(new URL("../src/plugins/ui/pageRegistry.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, Object, Set, Map, Error, TypeError }, { filename: sourcePath });
const { createPageRegistry } = exports;

function page(id, render = () => id) {
  return { id, render };
}

test("registration snapshots page descriptors and start opens the first page without rendering it", () => {
  const registry = createPageRegistry();
  const render = () => "welcome";
  const descriptor = { id: "welcome", render };
  registry.registerPage(descriptor);
  registry.registerPage(page("editor"));
  descriptor.id = "renamed";
  descriptor.render = () => "mutated";

  const beforeStart = registry.getSnapshot();
  assert.equal(registry.getSnapshot(), beforeStart);
  assert.equal(beforeStart.current, null);
  assert.deepEqual([...beforeStart.pages], []);

  registry.start();
  const started = registry.getSnapshot();
  assert.deepEqual({ ...started.current }, { id: "welcome", params: undefined });
  assert.deepEqual(Array.from(started.pages, ({ id, active, params }) => ({ id, active, params })), [
    { id: "welcome", active: true, params: undefined },
  ]);
  assert.equal(started.pages[0].render, render);
  assert.notEqual(started, beforeStart);
  assert.equal(registry.getSnapshot(), started, "unchanged reads return the same frozen snapshot");
  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(started.current), true);
  assert.equal(Object.isFrozen(started.pages), true);
  assert.equal(Object.isFrozen(started.pages[0]), true);
});

test("start validates registration and navigation is unavailable until it succeeds", () => {
  const registry = createPageRegistry();
  assert.throws(() => registry.openPage("welcome"), /must be started/);
  assert.throws(() => registry.back(), /must be started/);
  assert.throws(() => registry.start(), /without registered pages/);

  registry.registerPage(page("welcome"));
  assert.throws(() => registry.start("missing"), /not registered/);
  assert.equal(registry.getSnapshot().current, null, "a failed start leaves state untouched");
  registry.start("welcome");
  assert.throws(() => registry.start(), /already started/);
  assert.throws(() => registry.openPage("missing"), /not registered/);
});

test("navigation retains visited pages and parameters, avoids duplicate history, and back restores parameters", () => {
  const registry = createPageRegistry();
  const welcomeParams = { section: "projects" };
  const editorParams = { projectId: "novel-1" };
  registry.registerPage(page("welcome"));
  registry.registerPage(page("editor"));
  registry.registerPage(page("settings"));
  registry.start("welcome");
  registry.openPage("welcome", welcomeParams);
  const welcomeWithParams = registry.getSnapshot();
  assert.equal(welcomeWithParams.canGoBack, true);
  registry.openPage("welcome", welcomeParams);
  assert.equal(registry.getSnapshot(), welcomeWithParams, "the same page and params do not add history");

  registry.openPage("editor", editorParams);
  registry.openPage("settings");
  let snapshot = registry.getSnapshot();
  assert.deepEqual(Array.from(snapshot.pages, ({ id, active }) => [id, active]), [
    ["welcome", false], ["editor", false], ["settings", true],
  ]);
  assert.equal(snapshot.pages[1].params, editorParams);
  assert.equal(snapshot.canGoBack, true);

  registry.back();
  snapshot = registry.getSnapshot();
  assert.deepEqual({ ...snapshot.current }, { id: "editor", params: editorParams });
  assert.equal(snapshot.pages[1].active, true);
  registry.back();
  snapshot = registry.getSnapshot();
  assert.deepEqual({ ...snapshot.current }, { id: "welcome", params: welcomeParams });
  assert.equal(snapshot.pages[0].active, true);
  registry.back();
  assert.deepEqual({ ...registry.getSnapshot().current }, { id: "welcome", params: undefined });
  assert.equal(registry.getSnapshot().canGoBack, false);
});

test("back on an empty history is a no-op and snapshot identity remains stable", () => {
  const registry = createPageRegistry();
  registry.registerPage(page("welcome"));
  registry.start();
  const snapshot = registry.getSnapshot();
  registry.back();
  assert.equal(registry.getSnapshot(), snapshot);
});

test("subscriptions notify on state changes and unsubscribe idempotently", () => {
  const registry = createPageRegistry();
  registry.registerPage(page("welcome"));
  registry.registerPage(page("editor"));
  let calls = 0;
  const unsubscribe = registry.subscribe(() => { calls += 1; });
  registry.start();
  registry.openPage("editor");
  unsubscribe();
  unsubscribe();
  registry.back();
  assert.equal(calls, 2);

  assert.throws(() => registry.subscribe(null), /listener must be a function/);
});

test("page removal clears its visit, current location, and history entries, then notifies", () => {
  const registry = createPageRegistry();
  const removeWelcome = registry.registerPage(page("welcome"));
  const removeEditor = registry.registerPage(page("editor"));
  registry.registerPage(page("settings"));
  let calls = 0;
  registry.subscribe(() => { calls += 1; });
  registry.start("welcome");
  registry.openPage("editor", { projectId: "one" });
  registry.openPage("settings");
  assert.equal(calls, 3);

  removeEditor();
  removeEditor();
  assert.equal(calls, 4, "removal notifies once and its disposer is idempotent");
  assert.deepEqual(Array.from(registry.getSnapshot().pages, ({ id }) => id), ["welcome", "settings"]);
  registry.back();
  assert.deepEqual({ ...registry.getSnapshot().current }, { id: "welcome", params: undefined });
  assert.equal(registry.getSnapshot().canGoBack, false, "removed pages are removed from the remaining history");

  removeWelcome();
  assert.equal(registry.getSnapshot().current, null);
  assert.deepEqual(Array.from(registry.getSnapshot().pages, ({ id, active }) => [id, active]), [["settings", false]]);
  assert.equal(calls, 6, "removing the active page and the previously active page both notify");
});

test("invalid and duplicate page registrations are rejected", () => {
  const registry = createPageRegistry();
  assert.throws(() => registry.registerPage(null), /must be an object/);
  assert.throws(() => registry.registerPage({ id: "   ", render() {} }), /id cannot be empty/);
  assert.throws(() => registry.registerPage({ id: "valid", render: 1 }), /render must be a function/);
  registry.registerPage(page("valid"));
  assert.throws(() => registry.registerPage(page("valid")), /already registered/);
});

test("clear drops state and subscriptions; stale disposers cannot remove newly registered pages", () => {
  const registry = createPageRegistry();
  const oldDispose = registry.registerPage(page("welcome"));
  registry.start();
  let oldCalls = 0;
  const oldUnsubscribe = registry.subscribe(() => { oldCalls += 1; });
  registry.clear();

  const newDispose = registry.registerPage(page("welcome", () => "new"));
  let newCalls = 0;
  registry.subscribe(() => { newCalls += 1; });
  oldDispose();
  oldUnsubscribe();
  registry.start();
  registry.openPage("welcome", "again");
  assert.equal(oldCalls, 0, "clear detaches old listeners");
  assert.equal(newCalls, 2, "old unsubscription cannot remove a new subscription");
  assert.equal(registry.getSnapshot().pages[0].render(), "new");

  newDispose();
  assert.equal(registry.getSnapshot().current, null);
});
