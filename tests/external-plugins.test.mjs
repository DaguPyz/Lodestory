import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function loaderFixture({mountFailure = false, recordFailure = false, closeFailure = false} = {}) {
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
  const backend = {
    async call() {throw new Error("unused");},
    async close() {calls.push("close"); if (closeFailure) throw new Error("后端无法退出");},
  };
  const packages = {
    async prepare(id) {calls.push("prepare"); return {id, frontend: null, backend: {type: "process", entry: "/backend"}, requires: [], provides: []};},
    async setEnabled(id, enabled) {calls.push(`record:${id}:${enabled}`); if (recordFailure) throw new Error("记录写入失败");},
    async releaseAssets() {calls.push("release");},
    async list() {return [];},
  };
  let mounted;
  const runtime = {
    async mount(plugin) {
      calls.push("mount");
      if (mountFailure) throw new Error("内核忙");
      mounted = plugin;
      await plugin.activate({onStop() {}});
    },
    async unmount() {calls.push("unmount"); await mounted.deactivate(); mounted = undefined;},
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
  return {calls, service, stop, plugin};
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
