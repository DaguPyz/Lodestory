import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTypeFixtureCompiles,
  deferred,
  loadAppRuntime,
  plugin,
  serviceKey,
} from "./helpers/appRuntimeFixture.mjs";

test("the app runtime starts and stops with an empty plugin set", async () => {
  const f = loadAppRuntime();
  const runtime = await f.createAppRuntime([]);
  const missing = serviceKey("missing");

  assert.throws(() => runtime.get(missing), /not registered/);
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  await stopping;
});

test("the app runtime exposes any provided capability by its key token", async () => {
  const f = loadAppRuntime();
  const key = serviceKey("sample/read");
  const lookalikeKey = serviceKey(key.id);
  const service = Object.freeze({ read: () => 42 });
  const provider = plugin({
    id: "sample-provider",
    provides: [key],
    activate(context) { context.provide(key, service); },
  });
  const runtime = await f.createAppRuntime([provider]);

  assert.equal(runtime.get(key), service);
  assert.throws(() => runtime.get(lookalikeKey), /not registered/);
  await runtime.stop();
  assert.throws(() => runtime.get(key), /not registered/);
});

test("the returned promise waits until every plugin has finished activating", async () => {
  const f = loadAppRuntime();
  const ready = deferred();
  const key = serviceKey("async/ready");
  const service = { ready: true };
  const provider = plugin({
    id: "async-provider",
    provides: [key],
    async activate(context) {
      context.provide(key, service);
      await ready.promise;
    },
  });
  let resolved = false;
  const starting = f.createAppRuntime([provider]).then(runtime => {
    resolved = true;
    return runtime;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(f.createdCores.length, 1);
  assert.throws(() => f.createdCores[0].get(key), /not registered/);

  ready.resolve();
  const runtime = await starting;
  assert.equal(runtime.get(key), service);
  await runtime.stop();
});

test("the app runtime waits for the initial pluginsReady listeners before resolving", async () => {
  const f = loadAppRuntime();
  const listenerStarted = deferred();
  const finishListener = deferred();
  const calls = [];
  let resolved = false;
  const active = plugin({
    id: "ready-listener",
    activate(context) {
      calls.push("activate");
      context.on(f.pluginsReady, async (payload) => {
        assert.equal(payload, undefined);
        calls.push("ready:start");
        listenerStarted.resolve();
        await finishListener.promise;
        calls.push("ready:end");
      });
    },
  });

  const starting = f.createAppRuntime([active]).then((runtime) => {
    resolved = true;
    return runtime;
  });
  await listenerStarted.promise;
  assert.equal(resolved, false);
  assert.deepEqual(calls, ["activate", "ready:start"]);

  finishListener.resolve();
  const runtime = await starting;
  assert.equal(resolved, true);
  assert.deepEqual(calls, ["activate", "ready:start", "ready:end"]);
  await runtime.stop();
});

test("plugins activate by dependency order and stop in reverse order", async () => {
  const f = loadAppRuntime();
  const key = serviceKey("storage/connection");
  const calls = [];
  const consumer = plugin({
    id: "consumer",
    requires: [key],
    provides: [],
    activate(context) {
      calls.push(`activate consumer:${context.get(key).name}`);
    },
    deactivate() { calls.push("deactivate consumer"); },
  });
  const provider = plugin({
    id: "provider",
    requires: [],
    provides: [key],
    activate(context) {
      calls.push("activate provider");
      context.provide(key, { name: "database" });
    },
    deactivate() { calls.push("deactivate provider"); },
  });
  const runtime = await f.createAppRuntime([consumer, provider]);

  assert.deepEqual(calls, ["activate provider", "activate consumer:database"]);
  await runtime.stop();
  assert.deepEqual(calls, [
    "activate provider",
    "activate consumer:database",
    "deactivate consumer",
    "deactivate provider",
  ]);
});

test("a plugin activation failure rolls back the whole mounted batch", async () => {
  const f = loadAppRuntime();
  const key = serviceKey("provider/ready");
  const calls = [];
  const activationError = new Error("consumer activation failed");
  const consumer = plugin({
    id: "consumer",
    requires: [key],
    provides: [],
    activate() {
      calls.push("activate consumer");
      throw activationError;
    },
    deactivate() { calls.push("deactivate consumer"); },
  });
  const provider = plugin({
    id: "provider",
    provides: [key],
    activate(context) {
      calls.push("activate provider");
      context.provide(key, { ready: true });
    },
    deactivate() { calls.push("deactivate provider"); },
  });

  await assert.rejects(f.createAppRuntime([consumer, provider]), error => error === activationError);
  assert.deepEqual(calls, [
    "activate provider",
    "activate consumer",
    "deactivate consumer",
    "deactivate provider",
  ]);
  assert.throws(() => f.createdCores[0].get(key), /not registered/);
});

test("stop returns the same promise after successful cleanup", async () => {
  const f = loadAppRuntime();
  const calls = [];
  const active = plugin({
    id: "active",
    requires: [],
    provides: [],
    activate() { calls.push("activate"); },
    deactivate() { calls.push("deactivate"); },
  });
  const runtime = await f.createAppRuntime([active]);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(runtime.stop(), firstStop);
  assert.deepEqual(calls, ["activate", "deactivate"]);
});

test("stop called again from a deactivation callback shares the original promise", async () => {
  const f = loadAppRuntime();
  let runtime;
  let nestedStop;
  let cleanupCalls = 0;
  const active = plugin({
    id: "active",
    activate() {},
    deactivate() {
      cleanupCalls += 1;
      nestedStop = runtime.stop();
    },
  });
  runtime = await f.createAppRuntime([active]);

  const stopping = runtime.stop();
  await stopping;
  assert.equal(nestedStop, stopping);
  assert.equal(cleanupCalls, 1);
});

test("stop keeps cleaning all plugins and reuses its rejected promise", async () => {
  const f = loadAppRuntime();
  const key = serviceKey("provider/ready");
  const calls = [];
  const cleanupError = new Error("consumer cleanup failed");
  const consumer = plugin({
    id: "consumer",
    requires: [key],
    provides: [],
    activate() { calls.push("activate consumer"); },
    deactivate() {
      calls.push("deactivate consumer");
      throw cleanupError;
    },
  });
  const provider = plugin({
    id: "provider",
    provides: [key],
    activate(context) { context.provide(key, { ready: true }); },
    deactivate() { calls.push("deactivate provider"); },
  });
  const runtime = await f.createAppRuntime([consumer, provider]);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  await assert.rejects(firstStop, error => {
    assert.ok(error instanceof f.PluginBatchDeactivationError);
    assert.deepEqual(Array.from(error.cleanupErrors, entry => entry.pluginId), ["consumer"]);
    assert.equal(error.cleanupErrors[0].error, cleanupError);
    return true;
  });
  assert.equal(runtime.stop(), firstStop);
  assert.deepEqual(calls, ["activate consumer", "deactivate consumer", "deactivate provider"]);
  assert.throws(() => f.createdCores[0].get(key), /not registered/);
});

test("stop can be retried when a participant rejects preparation", async () => {
  const f = loadAppRuntime();
  let allow = false;
  let deactivated = 0;
  const runtime = await f.createAppRuntime([plugin({
    id: "guarded", requires: [], provides: [],
    activate(context) { context.onStop({check() { if (!allow) throw new Error("unsaved"); }}); },
    deactivate() { deactivated += 1; },
  })]);
  await assert.rejects(runtime.stop(), /stop check failed/);
  assert.equal(deactivated, 0);
  allow = true;
  await runtime.stop();
  assert.equal(deactivated, 1);
});

test("a stop blocked by an in-flight plugin removal can be retried", async () => {
  const f = loadAppRuntime();
  let finish;
  const gate = new Promise(resolve => {finish = resolve;});
  const runtime = await f.createAppRuntime([plugin({
    id: "slow", requires: [], provides: [], activate() {}, async deactivate() {await gate;},
  })]);
  const removing = runtime.unmount("slow");
  await assert.rejects(runtime.stop(), /changing state/);
  finish();
  await removing;
  await runtime.stop();
});

test("the TypeScript contract infers the service type from its key", () => {
  assertTypeFixtureCompiles();
});
