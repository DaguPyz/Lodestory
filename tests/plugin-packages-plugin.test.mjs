import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

test("package service uses registered contracts and releases them without relying on a concrete layout", async () => {
  const fixture = createMainFixture();
  const {createPluginPackagesPlugin} = fixture.loadModule("plugins/plugin-packages/pluginPackagesPlugin.ts");
  const calls = [];
  const record = {id: "com.example.one", name: "测试", version: "0.1.0", status: "pending-load"};
  const bridge = {
    async pick() {return "/example.zip";},
    async list() {return [record];},
    async importPackage(path, compatibility) {calls.push({path, compatibility}); return record;},
  };
  let service;
  let stop;
  const plugin = createPluginPackagesPlugin(bridge);
  plugin.activate({provide(_key, value) {service = value;}, onStop(value) {stop = value;}});
  const descriptor = {id: "example/layout@0", version: "0.1.0"};
  const remove = service.registerCapability(descriptor);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => {notifications++;});
  assert.throws(() => service.registerCapability(descriptor), /重复/);
  assert.equal((await service.importFromFile()).status, "pending-load");
  assert.equal(calls[0].path, "/example.zip");
  assert.equal(notifications, 1);
  assert.equal(calls[0].compatibility.hostApi, "0.1.0");
  assert.equal(calls[0].compatibility.capabilities[0].id, descriptor.id);
  remove(); remove();
  await service.importFromPath("/another.zip");
  assert.equal(calls[1].compatibility.capabilities.length, 0);
  assert.equal(notifications, 2);
  unsubscribe();
  await stop.prepare();
  await assert.rejects(service.list(), /停止/);
  stop.cancel();
  assert.equal((await service.list())[0].id, record.id);
  await plugin.deactivate();
  await assert.rejects(service.list(), /停止/);
});

test("stopping waits for an in-flight import, and cancelling the file chooser changes nothing", async () => {
  const fixture = createMainFixture();
  const {createPluginPackagesPlugin} = fixture.loadModule("plugins/plugin-packages/pluginPackagesPlugin.ts");
  let resolveImport;
  const bridge = {
    async pick() {return null;},
    async list() {return [];},
    importPackage() {return new Promise(resolve => {resolveImport = resolve;});},
  };
  let service;
  let stop;
  const plugin = createPluginPackagesPlugin(bridge);
  plugin.activate({provide(_key, value) {service = value;}, onStop(value) {stop = value;}});
  assert.equal(await service.importFromFile(), null);
  const importing = service.importFromPath("/example.zip");
  await Promise.resolve();
  let finished = false;
  const stopping = stop.prepare().then(() => {finished = true;});
  await Promise.resolve();
  assert.equal(finished, false);
  resolveImport({id: "com.example.one", name: "测试", version: "0.1.0", status: "pending-load"});
  await importing;
  await stopping;
  assert.equal(finished, true);
  await plugin.deactivate();
});

test("plugin management enters and leaves through the settings contract", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();
  const {settingsKey} = fixture.requireSdk("@lodestory/sdk/settings");
  const settings = fixture.getService(settingsKey);
  assert.equal(settings.open("plugins.packages"), true);
  await fixture.createdCores.at(-1).unmount("plugin-management");
  assert.equal(settings.open("plugins.packages"), false);
  await fixture.createdCores.at(-1).unmountAll();
});
