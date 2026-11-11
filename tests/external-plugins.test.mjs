import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function loaderFixture({mountFailure = false, recordFailure = false, closeFailure = false, closeFailureCount = 0, stopPrepare} = {}) {
  const fixture = createMainFixture({tauri: false});
  const {createExternalPluginsPlugin} = fixture.loadModule("plugins/external-plugins/externalPluginsPlugin.ts");
  const {pluginPackagesKey} = fixture.requireSdk("@lodestory/sdk/plugin-packages");
  const {pluginRuntimeKey} = fixture.requireSdk("@lodestory/sdk/plugin-runtime");
  const {nativeProcessLoaderKey} = fixture.requireSdk("@lodestory/sdk/native-process-loader");
  const {nativeLibraryLoaderKey} = fixture.requireSdk("@lodestory/sdk/native-library-loader");
  const {layoutKey} = fixture.requireSdk("@lodestory/sdk/layout");
  const {navigationLayoutKey} = fixture.requireSdk("@lodestory/sdk/navigation-layout");
  const {errorUiKey} = fixture.requireSdk("@lodestory/sdk/error");
  const {externalPluginsKey} = fixture.requireSdk("@lodestory/sdk/external-plugins");
  const calls = [];
  let closeFailures = closeFailureCount;
  let closed = false;
  const backend = {
    async call() {throw new Error("unused");},
    async close() {
      if (closed) return;
      calls.push("close");
      if (closeFailure || closeFailures > 0) {
        if (closeFailures > 0) closeFailures--;
        throw new Error("后端无法退出");
      }
      closed = true;
    },
  };
  let enabled = false;
  let installed = true;
  const packages = {
    async prepare(id) {calls.push("prepare"); return {id, frontend: null, backend: {type: "process", entry: "/backend"}, requires: [], provides: []};},
    async setEnabled(id, value) {calls.push(`record:${id}:${value}`); if (recordFailure) throw new Error("记录写入失败"); enabled = value;},
    async remove(id) {calls.push(`remove:${id}`); installed = false;},
    async releaseAssets() {calls.push("release");},
    async list() {return installed ? [{id: "com.example.test", enabled}] : [];},
  };
  let mounted;
  let stopParticipants = [];
  const runtime = {
    async mount(plugin) {
      calls.push("mount");
      if (mountFailure) throw new Error("内核忙");
      mounted = plugin;
      stopParticipants = [];
      await plugin.activate({onStop(participant) {stopParticipants.push(participant);}});
      if (stopPrepare) stopParticipants.push({prepare: stopPrepare});
    },
    async unmount() {
      calls.push("unmount");
      for (const participant of [...stopParticipants].reverse()) await participant.check?.("plugin");
      for (const participant of [...stopParticipants].reverse()) await participant.prepare?.("plugin");
      const ordered = stopParticipants.map((participant, index) => ({participant, index,
        order: typeof participant.withdrawOrder === "function" ? participant.withdrawOrder("plugin") : participant.withdrawOrder ?? 0,
      })).sort((left, right) => left.order - right.order || left.index - right.index);
      for (const {participant} of ordered) await participant.withdraw?.("plugin");
      try {await mounted.deactivate();}
      finally {mounted = undefined; stopParticipants = [];}
    },
  };
  const services = new Map([
    [pluginPackagesKey, packages], [pluginRuntimeKey, runtime],
    [nativeProcessLoaderKey, {async load(entry) {calls.push(`process:${entry}`); return backend;}}],
    [nativeLibraryLoaderKey, {async load() {throw new Error("不应使用动态库");}}],
    [layoutKey, {registerContents() {return [];}}],
    [navigationLayoutKey, {registerPages() {return [];}}],
    [errorUiKey, {ErrorBoundary: ({children}) => children}],
  ]);
  let service;
  let stop;
  const plugin = createExternalPluginsPlugin();
  plugin.activate({
    get(key) {if (!services.has(key)) throw new Error(`unexpected ${key.id}`); return services.get(key);},
    provide(key, value) {assert.equal(key, externalPluginsKey); service = value;},
    on() {},
    onStop(value) {stop = value;},
  });
  return {calls, service, stop, plugin, packages};
}

test("a backend is closed when the runtime refuses to mount it", async () => {
  const f = loaderFixture({mountFailure: true});
  await assert.rejects(f.service.enable("com.example.test"), /内核忙/);
  assert.deepEqual(f.calls, ["prepare", "process:/backend", "mount", "close", "release"]);
  assert.equal(f.service.getSnapshot()["com.example.test"].state, "error");
  await f.plugin.deactivate();
});

test("failure to persist an enabled plugin rolls back its running backend", async () => {
  const f = loaderFixture({recordFailure: true});
  await assert.rejects(f.service.enable("com.example.test"), /记录写入失败/);
  assert.deepEqual(f.calls, ["prepare", "process:/backend", "mount", "record:com.example.test:true", "unmount", "close", "release"]);
  assert.equal(f.service.getSnapshot()["com.example.test"].canRetry, true);
  await f.plugin.deactivate();
});

test("failed cleanup is reported and blocks a second backend from being started", async () => {
  const f = loaderFixture({mountFailure: true, closeFailure: true});
  await assert.rejects(f.service.enable("com.example.test"), /后端清理未完成/);
  assert.equal(f.service.getSnapshot()["com.example.test"].canRetry, false);
  await assert.rejects(f.service.enable("com.example.test"), /上次插件清理未完成/);
  assert.equal(f.calls.filter(call => call.startsWith("process:")).length, 1);
  await f.plugin.deactivate();
});

test("a stop veto leaves the plugin enabled and retries without remounting it", async () => {
  let allowStop = false;
  const f = loaderFixture({stopPrepare() {if (!allowStop) throw new Error("测试保存被拒绝");}});
  await f.service.enable("com.example.test");
  await assert.rejects(f.service.disable("com.example.test"), /测试保存被拒绝/);
  assert.equal(f.service.getSnapshot()["com.example.test"].state, "stop-error");
  assert.equal((await f.packages.list())[0].enabled, true);
  assert.equal(f.calls.filter(call => call === "mount").length, 1);
  allowStop = true;
  await f.service.disable("com.example.test");
  assert.equal(f.service.getSnapshot()["com.example.test"].state, "disabled");
  assert.equal((await f.packages.list())[0].enabled, false);
  assert.equal(f.calls.filter(call => call === "mount").length, 1);
});

test("uninstall retains a package after backend shutdown fails, then retries removal", async () => {
  const f = loaderFixture({closeFailureCount: 1});
  await f.service.enable("com.example.test");
  await assert.rejects(f.service.uninstall("com.example.test"), /后端无法退出/);
  assert.equal(f.service.getSnapshot()["com.example.test"].state, "stop-error");
  assert.equal(f.service.getSnapshot()["com.example.test"].canRetry, true);
  assert.deepEqual(await f.packages.list(), [{id: "com.example.test", enabled: false}]);
  assert.equal(f.calls.includes("remove:com.example.test"), false);
  await f.service.uninstall("com.example.test");
  assert.equal(f.calls.filter(call => call === "remove:com.example.test").length, 1);
  assert.deepEqual(await f.packages.list(), []);
  assert.equal(f.service.getSnapshot()["com.example.test"], undefined);
});
