import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function createFakeUi(initialPage = "welcome") {
  let current = Object.freeze({id: initialPage, params: undefined});
  const history = [];
  const guards = [];
  const events = [];

  function requestFor(to, kind = "open") {
    return Object.freeze({
      from: current,
      to: Object.freeze({id: to.id, params: to.params}),
      kind,
    });
  }

  async function navigate(request) {
    const approvals = [];
    try {
      for (const guard of guards) {
        const result = await guard.prepare(request);
        if (result === false) {
          for (const approval of [...approvals].reverse()) await approval.cancel?.();
          events.push("rejected");
          return false;
        }
        if (result !== true) approvals.push(result);
      }
      for (const approval of approvals) approval.commit?.();
      events.push("commit");
      if (request.kind === "open" && current) history.push(current);
      if (request.kind === "back") history.pop();
      current = request.to;
      events.push("current");
      for (const approval of approvals) await approval.complete?.();
      events.push("complete");
      return true;
    } catch (error) {
      for (const approval of [...approvals].reverse()) await approval.cancel?.();
      throw error;
    }
  }

  const service = {
    registerNavigationGuard(guard) {
      guards.push(guard);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    openPage(id, params) {
      const to = Object.freeze({id, params});
      if (current.id === id && Object.is(current.params, params)) return Promise.resolve(true);
      return navigate(requestFor(to));
    },
    back() {
      const previous = history.at(-1);
      if (!previous) return Promise.resolve(true);
      return navigate(Object.freeze({from: current, to: previous, kind: "back"}));
    },
    getSnapshot() { return Object.freeze({current, canGoBack: history.length > 0}); },
    subscribe() { return () => {}; },
  };

  return {
    service,
    events,
    addGuard: guard => service.registerNavigationGuard(guard),
    get current() { return current; },
    get history() { return history.slice(); },
  };
}

function createWorkbench({initialPage = "welcome", stopView = () => {}} = {}) {
  const fixture = createMainFixture();
  const ui = createFakeUi(initialPage);
  const {createWorkbenchStore} = fixture.loadModule("plugins/workbench/workbenchStore.ts");
  const store = createWorkbenchStore(ui.service, {
    editorPage: "editor",
    welcomePage: "welcome",
    stopView,
  });
  ui.addGuard({id: "workbench", prepare: request => store.prepareNavigation(request)});
  return {fixture, ui, store};
}

const project = (id, path = `/projects/${id}`) => ({id, name: `Project ${id}`, path});

test("participant registration is validated and snapshots are immutable", async () => {
  const {store} = createWorkbench();
  assert.throws(() => store.service.openProject(project("a")), /not ready/);
  assert.throws(() => store.service.registerParticipant(null), /requires an id and start/);
  assert.throws(() => store.service.registerParticipant({id: " ", start() {}}), /requires an id and start/);
  assert.throws(() => store.service.registerParticipant({id: "missing-start"}), /requires an id and start/);

  const remove = store.service.registerParticipant({id: "probe", start: () => ({dispose() {}})});
  assert.throws(() => store.service.registerParticipant({id: "probe", start() {}}), /already registered/);
  store.start();
  assert.throws(() => store.service.registerParticipant({id: "late", start() {}}), /before pluginsReady/);

  assert.equal(await store.service.openProject(project("a")), true);
  const first = store.service.getSnapshot();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.session));
  assert.ok(Object.isFrozen(first.session.project));
  assert.equal(store.service.getSnapshot(), first, "unchanged state returns the same snapshot");
  assert.throws(() => { first.session.project.name = "changed"; }, TypeError);
  await remove();
});

test("a malformed participation that already exposes dispose is rolled back", async () => {
  const {store} = createWorkbench();
  let disposals = 0;
  store.service.registerParticipant({
    id: "malformed",
    start: () => ({beforeLeave: "not a function", dispose() { disposals++; }}),
  });
  store.start();

  await assert.rejects(store.service.openProject(project("a")), /must return a disposable participation/);
  assert.equal(disposals, 1);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().busy, false);
});

test("a throwing snapshot listener cannot strand a project transition", async () => {
  const {store} = createWorkbench();
  store.service.registerParticipant({id: "probe", start: () => ({dispose() {}})});
  store.start();
  const oldError = console.error;
  console.error = () => {};
  try {
    store.service.subscribe(() => { throw new Error("observer failed"); });
    assert.equal(await store.service.openProject(project("a")), true);
  } finally {
    console.error = oldError;
  }
  assert.equal(store.service.getSnapshot().session.project.id, "a");
  assert.equal(store.service.getSnapshot().busy, false);
});

test("suspending the editor keeps its project session and participant resources", async () => {
  const {ui, store} = createWorkbench();
  const calls = [];
  store.service.registerParticipant({
    id: "documents",
    start(session) {
      calls.push(`start:${session.project.id}`);
      return {
        beforeLeave: reason => { calls.push(`leave:${reason}`); return true; },
        dispose: () => calls.push("dispose"),
      };
    },
  });
  store.start();

  await store.service.openProject(project("a"));
  const session = store.service.getSnapshot().session;
  await ui.service.openPage("settings");
  assert.equal(store.service.getSnapshot().session, session);
  assert.equal(store.service.getSnapshot().active, false);
  assert.equal(calls.includes("dispose"), false);
  assert.deepEqual(calls, ["start:a", "leave:suspend"]);

  assert.equal(await ui.service.back(), true);
  assert.equal(store.service.getSnapshot().session, session);
  assert.equal(store.service.getSnapshot().active, true);
  assert.deepEqual(calls, ["start:a", "leave:suspend"]);
});

test("closeProject uses the close reason and retains the project when a participant vetoes", async () => {
  const {ui, store} = createWorkbench();
  let allowClose = false;
  let disposals = 0;
  store.service.registerParticipant({
    id: "documents",
    start() {
      return {
        beforeLeave(reason) {
          assert.equal(reason, "close");
          return allowClose;
        },
        dispose() { disposals++; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));
  const original = store.service.getSnapshot().session;

  assert.equal(await store.service.closeProject(), false);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(ui.current.id, "editor");
  assert.equal(disposals, 0);

  allowClose = true;
  assert.equal(await store.service.closeProject(), true);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(ui.current.id, "welcome");
  assert.equal(disposals, 1);
});

test("a veto or thrown save check preserves the current project identity and resources", async () => {
  const {store} = createWorkbench();
  let decision = true;
  let errorOnLeave = false;
  let disposals = 0;
  store.service.registerParticipant({
    id: "documents",
    start() {
      return {
        beforeLeave(reason) {
          if (reason !== "switch") return true;
          if (errorOnLeave) throw new Error("save failed");
          return decision;
        },
        dispose() { disposals++; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));
  const original = store.service.getSnapshot().session;

  decision = false;
  assert.equal(await store.service.openProject(project("b")), false);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(disposals, 0);

  decision = true;
  errorOnLeave = true;
  await assert.rejects(store.service.openProject(project("b")), /save failed/);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(disposals, 0);
});

test("switch checks the old project before starting the new one and disposes old resources after UI commit", async () => {
  const {ui, store} = createWorkbench();
  const calls = [];
  store.service.registerParticipant({
    id: "one",
    start(session) {
      calls.push(`start-one:${session.project.id}`);
      return {beforeLeave: reason => { calls.push(`check-one:${reason}`); return true; }, dispose: () => calls.push(`dispose-one:${session.project.id}`)};
    },
  });
  store.service.registerParticipant({
    id: "two",
    start(session) {
      calls.push(`start-two:${session.project.id}`);
      return {beforeLeave: reason => { calls.push(`check-two:${reason}`); return true; }, dispose: () => calls.push(`dispose-two:${session.project.id}`)};
    },
  });
  store.start();
  await store.service.openProject(project("a"));
  calls.length = 0;
  ui.events.length = 0;

  assert.equal(await store.service.openProject(project("b")), true);
  assert.deepEqual(calls, [
    "check-one:switch", "check-two:switch",
    "start-one:b", "start-two:b",
    "dispose-two:a", "dispose-one:a",
  ]);
  assert.deepEqual(ui.events, ["commit", "current", "complete"]);
  assert.equal(ui.current.id, "editor");
  assert.equal(ui.current.params.project.id, "b");
  assert.equal(store.service.getSnapshot().session.project.id, "b");
});

test("failed project initialization rolls back new participants in reverse and keeps the old session", async () => {
  const {store} = createWorkbench();
  const calls = [];
  store.service.registerParticipant({
    id: "one",
    start(session) {
      calls.push(`start-one:${session.project.id}`);
      return {beforeLeave: () => true, dispose: () => calls.push(`dispose-one:${session.project.id}`)};
    },
  });
  store.service.registerParticipant({
    id: "two",
    start(session) {
      calls.push(`start-two:${session.project.id}`);
      if (session.project.id === "b") throw new Error("second participant failed");
      return {beforeLeave: () => true, dispose: () => calls.push(`dispose-two:${session.project.id}`)};
    },
  });
  store.start();
  await store.service.openProject(project("a"));
  const original = store.service.getSnapshot().session;

  await assert.rejects(store.service.openProject(project("b")), /second participant failed/);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.deepEqual(calls, [
    "start-one:a", "start-two:a",
    "start-one:b", "start-two:b", "dispose-one:b",
  ]);

  await store.service.closeProject();
  assert.deepEqual(calls.slice(-2), ["dispose-two:a", "dispose-one:a"]);
});

test("a later UI guard rejection cancels prepared workbench resources", async () => {
  const {ui, store} = createWorkbench();
  let disposals = 0;
  store.service.registerParticipant({id: "probe", start: () => ({dispose() { disposals++; }})});
  store.start();
  ui.addGuard({id: "reject", prepare: () => false});

  assert.equal(await store.service.openProject(project("a")), false);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(disposals, 1);
  assert.equal(ui.current.id, "welcome");
});

test("busy transitions reject concurrent project opens and keep the pending transition isolated", async () => {
  const {store} = createWorkbench();
  const gate = deferred();
  store.service.registerParticipant({
    id: "slow",
    async start(session) {
      await gate.promise;
      return {dispose() {}};
    },
  });
  store.start();

  const opening = store.service.openProject(project("a"));
  await Promise.resolve();
  assert.equal(store.service.getSnapshot().busy, true);
  assert.equal(await store.service.openProject(project("b")), false);
  gate.resolve();
  assert.equal(await opening, true);
  assert.equal(store.service.getSnapshot().session.project.id, "a");
  assert.equal(store.service.getSnapshot().busy, false);
});

test("shutdown waits for saves, preserves the session on veto or error, then releases it", async () => {
  let stopViewCalls = 0;
  const {store} = createWorkbench({stopView: () => { stopViewCalls++; }});
  let leaveMode = "throw";
  let disposals = 0;
  store.service.registerParticipant({
    id: "documents",
    start() {
      return {
        beforeLeave(reason) {
          assert.equal(reason, "shutdown");
          if (leaveMode === "throw") throw new Error("save failed");
          return leaveMode !== "veto";
        },
        dispose() { disposals++; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));
  const original = store.service.getSnapshot().session;

  await assert.rejects(store.shutdown(), /save failed/);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, true);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(stopViewCalls, 0);
  assert.equal(disposals, 0);

  leaveMode = "veto";
  assert.equal(await store.shutdown(), false);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(stopViewCalls, 0);
  assert.equal(disposals, 0);

  leaveMode = "allow";
  assert.equal(await store.shutdown(), true);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().active, false);
  assert.equal(stopViewCalls, 1);
  assert.equal(disposals, 1);
});

test("store disposal must wait for a pending shutdown leave check before disposing participant resources", async () => {
  const {store} = createWorkbench();
  const gate = deferred();
  let disposed = false;
  store.service.registerParticipant({
    id: "locked-resource",
    start() {
      return {
        beforeLeave: reason => reason === "shutdown" ? gate.promise : true,
        dispose() { disposed = true; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));

  const shutdown = store.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = store.dispose();
  await new Promise(resolve => setImmediate(resolve));
  const disposedBeforeCheckFinished = disposed;
  gate.resolve(true);
  await Promise.allSettled([shutdown, stopping]);

  assert.equal(disposedBeforeCheckFinished, false, "dispose must serialize behind an in-flight shutdown check");
  assert.equal(disposed, true);
});

test("participant revocation must wait for a pending shutdown leave check before disposal", async () => {
  const {store} = createWorkbench();
  const gate = deferred();
  let disposed = false;
  const remove = store.service.registerParticipant({
    id: "locked-resource",
    start() {
      return {
        beforeLeave: reason => reason === "shutdown" ? gate.promise : true,
        dispose() { disposed = true; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));

  const shutdown = store.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  const removing = remove();
  await new Promise(resolve => setImmediate(resolve));
  const disposedBeforeCheckFinished = disposed;
  gate.resolve(true);
  await Promise.allSettled([shutdown, removing]);

  assert.equal(disposedBeforeCheckFinished, false, "revocation must serialize behind an in-flight shutdown check");
  assert.equal(disposed, true);
});

test("shutdown must not inspect a participant while its revocation cleanup is pending", async () => {
  const {store} = createWorkbench();
  const cleanup = deferred();
  let disposeStarted = false;
  let checksAfterDisposeStarted = 0;
  const remove = store.service.registerParticipant({
    id: "locked-resource",
    start() {
      return {
        beforeLeave(reason) {
          if (disposeStarted && reason === "shutdown") checksAfterDisposeStarted++;
          return true;
        },
        dispose() { disposeStarted = true; return cleanup.promise; },
      };
    },
  });
  store.start();
  await store.service.openProject(project("a"));

  const removing = remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposeStarted, true);
  const shutdown = store.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  const checksDuringCleanup = checksAfterDisposeStarted;
  cleanup.resolve();
  await Promise.allSettled([removing, shutdown]);

  assert.equal(checksDuringCleanup, 0, "shutdown must serialize behind participant revocation");
});

test("disposing while participant start is pending prevents the late session from being published", async () => {
  const {store} = createWorkbench();
  const gate = deferred();
  let disposals = 0;
  store.service.registerParticipant({
    id: "slow",
    async start() {
      await gate.promise;
      return {dispose() { disposals++; }};
    },
  });
  store.start();

  const opening = store.service.openProject(project("a"));
  await Promise.resolve();
  const stopping = store.dispose();
  gate.resolve();
  const result = await Promise.allSettled([opening, stopping]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.equal(disposals, 1);
  assert.throws(() => store.service.getSnapshot(), /no longer active/);
});

test("async participant revocation stops the view, awaits cleanup, and shares its promise", async () => {
  let stopViewCalls = 0;
  const {store} = createWorkbench({stopView: () => { stopViewCalls++; }});
  const cleanup = deferred();
  let cleanupStarted = false;
  let removed = false;
  const remove = store.service.registerParticipant({
    id: "replaceable",
    start: () => ({dispose() { cleanupStarted = true; return cleanup.promise; }}),
  });
  store.start();
  await store.service.openProject(project("a"));
  const removal = remove();
  assert.equal(remove(), removal, "repeated revocation shares the same promise");
  void removal.then(() => { removed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopViewCalls, 1);
  assert.equal(cleanupStarted, true);
  assert.equal(removed, false);
  cleanup.resolve();
  await removal;
  assert.equal(removed, true);
  assert.equal(stopViewCalls, 1);
  assert.equal(store.service.getSnapshot().session, null);
});

test("an old idempotent disposer cannot remove a later registration with the same id", async () => {
  const {store} = createWorkbench();
  let newStarts = 0;
  const removeOld = store.service.registerParticipant({id: "replaceable", start: () => ({dispose() {}})});
  const firstRemoval = removeOld();
  await firstRemoval;
  store.service.registerParticipant({id: "replaceable", start() { newStarts++; return {dispose() {}}; }});
  assert.equal(removeOld(), firstRemoval);
  store.start();
  assert.equal(await store.service.openProject(project("b")), true);
  assert.equal(newStarts, 1);
});

test("dispose still releases participants when stopping the view throws", async () => {
  const {store} = createWorkbench({stopView: () => { throw new Error("view stop failed"); }});
  let disposals = 0;
  store.service.registerParticipant({id: "probe", start: () => ({dispose() { disposals++; }})});
  store.start();
  await store.service.openProject(project("a"));

  await assert.rejects(store.dispose(), /failed to dispose/);
  assert.equal(disposals, 1);
  assert.throws(() => store.service.getSnapshot(), /no longer active/);
});
