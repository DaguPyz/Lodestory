import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function waitFor(action, message = "condition did not become true") {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (action()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

async function openReady(service, target) {
  const opened = await service.openProject(target);
  if (opened) await waitFor(() => !service.getSnapshot().busy || service.getSnapshot().loading?.error,
    "workbench startup did not settle");
  return opened;
}

function createFakeUi(initialPage = "welcome") {
  let current = Object.freeze({id: initialPage, params: undefined});
  const history = [];
  const guards = [];
  const events = [];

  function requestFor(to, kind = "open", historyMode) {
    return Object.freeze({
      from: current,
      to: Object.freeze({id: to.id, params: to.params}),
      kind,
      ...(historyMode === "reset" ? {history: "reset"} : {}),
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
      if (request.kind === "open" && request.history === "reset") history.length = 0;
      else if (request.kind === "open" && current) history.push(current);
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
    openPage(id, params, options) {
      const to = Object.freeze({id, params});
      if (current.id === id && Object.is(current.params, params)
        && (options?.history !== "reset" || history.length === 0)) return Promise.resolve(true);
      return navigate(requestFor(to, "open", options?.history));
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

function createWorkbench({initialPage = "welcome", stopView = () => {}, flushView} = {}) {
  const fixture = createMainFixture();
  const ui = createFakeUi(initialPage);
  const {createWorkbenchStore} = fixture.loadModule("plugins/workbench/workbenchStore.ts");
  const store = createWorkbenchStore(ui.service, {
    editorPage: "editor",
    welcomePage: "welcome",
    stopView,
    flushView,
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

  assert.equal(await openReady(store.service, project("a")), true);
  const first = store.service.getSnapshot();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.session));
  assert.ok(Object.isFrozen(first.session.project));
  assert.equal(store.service.getSnapshot(), first, "unchanged state returns the same snapshot");
  assert.throws(() => { first.session.project.name = "changed"; }, TypeError);
  remove.associate(Symbol("probe"));
  remove.check("plugin");
  await remove.prepare("plugin");
  await remove.withdraw("plugin");
  await remove();
});

test("a malformed participation is cleaned and exposed as a locked startup error", async () => {
  const {store} = createWorkbench();
  let disposals = 0;
  store.service.registerParticipant({
    id: "malformed",
    start: () => ({beforeLeave: "not a function", dispose() { disposals++; }}),
  });
  store.start();

  assert.equal(await store.service.openProject(project("a")), true, "the editor route commits before preparation finishes");
  await waitFor(() => store.service.getSnapshot().loading?.error, "malformed startup did not report an error");
  assert.equal(disposals, 1);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().busy, true);
  assert.match(store.service.getSnapshot().loading.error.message, /must return a disposable participation/);
  assert.equal(await store.service.returnProject(), true);
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
    assert.equal(await openReady(store.service, project("a")), true);
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

  await openReady(store.service, project("a"));
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
  await openReady(store.service, project("a"));
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
  await openReady(store.service, project("a"));
  const original = store.service.getSnapshot().session;

  decision = false;
  assert.equal(await openReady(store.service, project("b")), false);
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
  await openReady(store.service, project("a"));
  calls.length = 0;
  ui.events.length = 0;

  assert.equal(await openReady(store.service, project("b")), true);
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

test("failed project initialization cleans candidate resources and restores the old session behind a recovery lock", async () => {
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
  await openReady(store.service, project("a"));
  const original = store.service.getSnapshot().session;

  assert.equal(await openReady(store.service, project("b")), true);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, false);
  assert.equal(store.service.getSnapshot().busy, true);
  assert.match(store.service.getSnapshot().loading.error.message, /second participant failed/);
  assert.deepEqual(calls, [
    "start-one:a", "start-two:a",
    "start-one:b", "start-two:b", "dispose-one:b",
  ]);

  assert.equal(await store.service.returnProject(), true);
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, true);
  assert.equal(store.service.getSnapshot().busy, false);

  await store.service.closeProject();
  assert.deepEqual(calls.slice(-2), ["dispose-two:a", "dispose-one:a"]);
});

test("returning from a failed switch restores the original route and removes the failed route from history", async () => {
  const {ui, store} = createWorkbench();
  let startsForB = 0;
  store.service.registerParticipant({id: "first", start(session) {
    if (session.project.id === "b" && ++startsForB > 0) throw new Error("b failed");
    return {dispose() {}};
  }});
  store.start();
  await openReady(store.service, project("a"));
  const original = store.service.getSnapshot().session;

  assert.equal(await store.service.openProject(project("b")), true);
  await waitFor(() => store.service.getSnapshot().loading?.error, "switch did not fail");
  assert.equal(ui.current.params.project.id, "b");

  assert.equal(await store.service.returnProject(), true);
  assert.equal(ui.current.id, "editor");
  assert.equal(ui.current.params.project.id, "a");
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, true);
  assert.equal(store.service.getSnapshot().busy, false);

  await ui.service.openPage("settings");
  await ui.service.back();
  assert.equal(ui.current.params.project.id, "a", "back must not resurrect the failed project route");
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(startsForB, 1);
});

test("returning from a failed history-reset open restores the prior page without using stale history", async () => {
  const {ui, store} = createWorkbench();
  store.service.registerParticipant({id: "first", start() { throw new Error("startup failed"); }});
  store.start();

  assert.equal(await ui.service.openPage("editor", {project: project("a")}, {history: "reset"}), true);
  await waitFor(() => store.service.getSnapshot().loading?.error, "startup did not fail");
  assert.equal(ui.history.length, 0, "the reset open has no previous history entry");

  assert.equal(await store.service.returnProject(), true);
  assert.equal(ui.current.id, "welcome");
  assert.equal(ui.history.length, 0);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().busy, false);
});

test("closing during startup waits for pending resources and preserves shutdown leave checks", async () => {
  let stopViewCount = 0;
  const {ui, store} = createWorkbench({stopView: () => { stopViewCount++; }});
  const gate = deferred();
  let started = false;
  let disposalCount = 0;
  let allowShutdown = false;
  store.service.registerParticipant({id: "documents", async start(session) {
    if (session.project.id === "b") {
      started = true;
      await gate.promise;
    }
    return {
      beforeLeave(reason) { return reason !== "shutdown" || allowShutdown; },
      dispose() { disposalCount++; },
    };
  }});
  store.start();
  await openReady(store.service, project("a"));
  const previous = store.service.getSnapshot().session;

  const switching = store.service.openProject(project("b"));
  await waitFor(() => started, "candidate startup did not begin");
  assert.equal(await switching, true);
  const closing = store.shutdown();
  await waitFor(() => store.service.getSnapshot().session === previous, "candidate view was not detached before waiting");
  assert.equal(store.service.getSnapshot().busy, true);
  assert.equal(disposalCount, 0, "the in-flight participant is not released before it returns");

  gate.resolve();
  assert.equal(await closing, false, "the previous session's shutdown check must still be honored");
  assert.equal(disposalCount, 1, "the cancelled candidate resource is released after start settles");
  assert.equal(ui.current.params.project.id, "a", "shutdown veto restores the previous route and pops the candidate route");
  assert.equal(store.service.getSnapshot().session, previous);
  assert.equal(store.service.getSnapshot().active, true);
  assert.equal(store.service.getSnapshot().busy, false);

  allowShutdown = true;
  assert.equal(await store.shutdown(), true);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(disposalCount, 2);
  assert.equal(stopViewCount, 1);
});

test("closing during the first startup detaches the view and waits for the participant to settle", async () => {
  const gate = deferred();
  let started = false;
  let disposed = 0;
  let stopViewCount = 0;
  const {store} = createWorkbench({stopView: () => { stopViewCount++; }});
  store.service.registerParticipant({id: "slow", async start() {
    started = true;
    await gate.promise;
    return {dispose() { disposed++; }};
  }});
  store.start();

  const opening = store.service.openProject(project("a"));
  await waitFor(() => started, "participant startup did not begin");
  assert.equal(await opening, true);
  let closed = false;
  const closing = store.shutdown().then(result => { closed = true; return result; });
  await waitFor(() => store.service.getSnapshot().session === null, "candidate view was not detached");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "shutdown waits for the in-flight participant to return its resource");
  assert.equal(disposed, 0, "an unknown in-flight resource is never released early");

  gate.resolve();
  assert.equal(await closing, true);
  assert.equal(disposed, 1);
  assert.equal(stopViewCount, 1);
  assert.equal(store.service.getSnapshot().busy, false);
});

test("a rejected route restore after shutdown veto stays locked with retry and return recovery", async () => {
  const {ui, store} = createWorkbench();
  const gate = deferred();
  let candidateStarted = false;
  let candidateDisposals = 0;
  let blockBack = true;
  store.service.registerParticipant({id: "documents", async start(session) {
    if (session.project.id === "b") {
      candidateStarted = true;
      await gate.promise;
    }
    return {
      beforeLeave(reason) { return reason !== "shutdown"; },
      dispose() { if (session.project.id === "b") candidateDisposals++; },
    };
  }});
  store.start();
  await openReady(store.service, project("a"));
  const original = store.service.getSnapshot().session;
  ui.addGuard({id: "reject-route-restore", prepare: request => !(blockBack && request.kind === "back")});

  const switching = store.service.openProject(project("b"));
  await waitFor(() => candidateStarted, "candidate startup did not begin");
  assert.equal(await switching, true);
  const closed = await (async () => {
    const closing = store.shutdown();
    gate.resolve();
    return closing;
  })();

  assert.equal(closed, false);
  assert.equal(ui.current.params.project.id, "b", "the rejected back navigation leaves the candidate route visible");
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, false);
  assert.equal(store.service.getSnapshot().busy, true, "route/session mismatch must remain locked");
  assert.match(store.service.getSnapshot().loading.error.message, /无法返回原页面/);
  assert.equal(candidateDisposals, 1, "candidate resources are cleaned while the old session stays alive");

  blockBack = false;
  assert.equal(await store.service.returnProject(), true, "the recovery action can retry route restoration");
  assert.equal(ui.current.params.project.id, "a");
  assert.equal(store.service.getSnapshot().session, original);
  assert.equal(store.service.getSnapshot().active, true);
  assert.equal(store.service.getSnapshot().busy, false);
});

test("startup progress stays complete while the old session resources are being released", async () => {
  const {store} = createWorkbench();
  const cleanup = deferred();
  let cleanupStarted = false;
  store.service.registerParticipant({id: "documents", start(session) {
    return {dispose() {
      if (session.project.id === "a") {
        cleanupStarted = true;
        return cleanup.promise;
      }
    }};
  }});
  store.start();
  await openReady(store.service, project("a"));

  const switching = store.service.openProject(project("b"));
  await waitFor(() => cleanupStarted, "old session cleanup did not start");
  const snapshot = store.service.getSnapshot();
  assert.equal(snapshot.session.project.id, "b");
  assert.equal(snapshot.busy, true);
  assert.deepEqual({...snapshot.loading}, {completed: 1, total: 1, current: null, error: null});

  cleanup.resolve();
  assert.equal(await switching, true);
  await waitFor(() => !store.service.getSnapshot().busy, "old session cleanup did not finish");
  assert.equal(store.service.getSnapshot().loading, null);
});

test("the committed editor shows labeled participant progress while startup is pending", async () => {
  const {ui, store} = createWorkbench();
  const gate = deferred();
  let started = false;
  store.service.registerParticipant({
    id: "documents",
    label: "读取文稿",
    async start() {
      started = true;
      await gate.promise;
      return {dispose() {}};
    },
  });
  store.start();

  const opening = store.service.openProject(project("a"));
  await waitFor(() => started, "participant startup did not begin");
  assert.equal(ui.current.id, "editor", "route is committed while participant preparation is pending");
  assert.equal(store.service.getSnapshot().busy, true);
  assert.deepEqual({...store.service.getSnapshot().loading}, {
    completed: 0, total: 1, current: "读取文稿", error: null,
  });
  assert.equal(await store.service.openProject(project("b")), false, "a second project cannot replace the pending one");

  gate.resolve();
  assert.equal(await opening, true);
  await waitFor(() => !store.service.getSnapshot().busy, "participant startup did not finish");
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(store.service.getSnapshot().loading, null);
});

test("retry creates a fresh session after startup failure and return restores the welcome page", async () => {
  const {ui, store} = createWorkbench();
  let starts = 0;
  const sessionIds = [];
  store.service.registerParticipant({id: "documents", start(session) {
    sessionIds.push(session.id);
    if (++starts === 1) throw new Error("temporary load failure");
    return {dispose() {}};
  }});
  store.start();

  assert.equal(await store.service.openProject(project("a")), true);
  await waitFor(() => store.service.getSnapshot().loading?.error, "initial startup did not fail");
  assert.match(store.service.getSnapshot().loading.error.message, /temporary load failure/);
  const failedSnapshot = store.service.getSnapshot();
  assert.equal(failedSnapshot.session, null, "a first-load failure removes the candidate session from the view");
  assert.equal(await store.service.retryProject(), true);
  await waitFor(() => !store.service.getSnapshot().busy, "retry did not complete");
  assert.equal(starts, 2);
  assert.notEqual(sessionIds[1], sessionIds[0], "retry gets a fresh isolated session ID");
  assert.equal(store.service.getSnapshot().loading, null);

  await store.service.closeProject();
  assert.equal(ui.current.id, "welcome");
});

test("startup recovery actions stay unavailable until failed participant cleanup finishes", async () => {
  const {store} = createWorkbench();
  const cleanup = deferred();
  store.service.registerParticipant({id: "first", start: () => ({dispose: () => cleanup.promise})});
  store.service.registerParticipant({id: "second", label: "第二步骤", start() { throw new Error("load failed"); }});
  store.start();

  const opening = store.service.openProject(project("a"));
  await waitFor(() => store.service.getSnapshot().loading?.current === "第二步骤", "second step did not start");
  await waitFor(() => store.service.getSnapshot().session === null, "candidate view was not removed before cleanup");
  assert.equal(store.service.getSnapshot().loading.error, null, "error actions are withheld while cleanup runs");
  assert.equal(await store.service.retryProject(), false);
  assert.equal(await store.service.returnProject(), false);

  cleanup.resolve();
  assert.equal(await opening, true);
  await waitFor(() => store.service.getSnapshot().loading?.error, "startup cleanup did not finish");
  assert.match(store.service.getSnapshot().loading.error.message, /load failed/);
  assert.equal(await store.service.returnProject(), true);
  assert.equal(store.service.getSnapshot().busy, false);
});

test("a later UI guard rejection does not start project participants", async () => {
  const {ui, store} = createWorkbench();
  let disposals = 0;
  store.service.registerParticipant({id: "probe", start: () => ({dispose() { disposals++; }})});
  store.start();
  ui.addGuard({id: "reject", prepare: () => false});

  assert.equal(await store.service.openProject(project("a")), false);
  assert.equal(store.service.getSnapshot().session, null);
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(disposals, 0);
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
  await waitFor(() => store.service.getSnapshot().busy, "participant startup did not begin");
  assert.equal(store.service.getSnapshot().busy, true);
  assert.equal(await store.service.openProject(project("b")), false);
  gate.resolve();
  assert.equal(await opening, true);
  await waitFor(() => !store.service.getSnapshot().busy, "participant startup did not finish");
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
  await openReady(store.service, project("a"));
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
  await openReady(store.service, project("a"));

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

test("participant revocation is rejected during a pending shutdown leave check", async () => {
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
  await openReady(store.service, project("a"));

  const shutdown = store.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => remove.check("plugin"), /Workbench is busy/);
  await new Promise(resolve => setImmediate(resolve));
  const disposedBeforeCheckFinished = disposed;
  gate.resolve(true);
  await shutdown;
  await remove();

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
  await openReady(store.service, project("a"));

  remove.associate(Symbol("participant"));
  remove.check("plugin");
  await remove.prepare("plugin");
  const removing = remove.withdraw("plugin");
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
  let started = false;
  store.service.registerParticipant({
    id: "slow",
    async start() {
      started = true;
      await gate.promise;
      return {dispose() { disposals++; }};
    },
  });
  store.start();

  const opening = store.service.openProject(project("a"));
  await waitFor(() => started, "participant startup did not begin before disposal");
  const stopping = store.dispose();
  gate.resolve();
  const result = await Promise.allSettled([opening, stopping]);
  assert.equal(result[0].status, "fulfilled", result[0].status === "rejected" ? String(result[0].reason) : "");
  assert.equal(result[1].status, "fulfilled");
  assert.equal(disposals, 1);
  assert.throws(() => store.service.getSnapshot(), /no longer active/);
});

test("async participant withdrawal keeps the view and awaits only its own cleanup", async () => {
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
  await openReady(store.service, project("a"));
  remove.associate(Symbol("replaceable"));
  remove.check("plugin");
  await remove.prepare("plugin");
  const removal = remove.withdraw("plugin");
  void removal.then(() => { removed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopViewCalls, 0);
  assert.equal(cleanupStarted, true);
  assert.equal(removed, false);
  cleanup.resolve();
  await removal;
  assert.equal(removed, true);
  assert.equal(stopViewCalls, 0);
  assert.equal(store.service.getSnapshot().session.project.id, "a");
  assert.equal(remove(), remove(), "repeated final cleanup shares one promise");
  await remove();
});

test("failed participant cleanup keeps the session and cannot be mistaken for a successful retry", async () => {
  let stopViewCalls = 0;
  const {store} = createWorkbench({stopView: () => { stopViewCalls++; }});
  const remove = store.service.registerParticipant({
    id: "failing-cleanup",
    start: () => ({beforeLeave: () => true, dispose() {throw new Error("cleanup failed");}}),
  });
  store.start();
  await openReady(store.service, project("a"));
  remove.associate(Symbol("owner"));
  remove.check("plugin");
  await remove.prepare("plugin");
  await assert.rejects(remove.withdraw("plugin"), /Workbench resources failed to clean up/);
  remove.cancel("plugin");
  assert.equal(store.service.getSnapshot().session.project.id, "a");
  assert.equal(store.service.getSnapshot().busy, false);
  assert.equal(stopViewCalls, 0);
  await remove.prepare("plugin");
  await assert.rejects(remove.withdraw("plugin"), /Workbench resources failed to clean up/);
  remove.cancel("plugin");
  assert.equal(store.service.getSnapshot().session.project.id, "a");
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
  assert.equal(await openReady(store.service, project("b")), true);
  assert.equal(newStarts, 1);
});

test("dispose still releases participants when stopping the view throws", async () => {
  const {store} = createWorkbench({stopView: () => { throw new Error("view stop failed"); }});
  let disposals = 0;
  store.service.registerParticipant({id: "probe", start: () => ({dispose() { disposals++; }})});
  store.start();
  await openReady(store.service, project("a"));

  await assert.rejects(store.dispose(), /failed to dispose/);
  assert.equal(disposals, 1);
  assert.throws(() => store.service.getSnapshot(), /no longer active/);
});
