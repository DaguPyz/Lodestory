import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function setup({installed = false} = {}) {
  const {createPluginDevelopment} = createMainFixture().loadModule("plugins/external-plugins/pluginDevelopment.ts");
  const id = "com.example.dev";
  const calls = [];
  const failing = new Set();
  const staged = new Set();
  let running = installed ? "installed" : undefined;
  let latest = {revision: null};
  let veto = false;
  let status = installed ? {state: "enabled"} : undefined;
  const development = createPluginDevelopment({
    async readDevelopmentStatus() {return latest;},
    async stageDevelopmentBuild(folder, revision) {
      assert.equal(folder, "/plugin");
      calls.push(`stage:${revision}`);
      staged.add(revision);
      return {id, revision, token: revision};
    },
    async discardDevelopmentBuild(token) {
      assert.notEqual(token, running);
      staged.delete(token);
      calls.push(`discard:${token}`);
    },
  }, {
    status: () => status,
    updateStatus(_id, value) {status = value;},
    isRunning: () => running !== undefined,
    async stop() {
      calls.push(`stop:${running}`);
      if (veto) throw new Error("保存被拒绝");
      running = undefined;
      status = undefined;
      return async () => {calls.push("reopen");};
    },
    async load(build) {
      assert.equal(running, undefined);
      assert.equal(staged.has(build.token), true);
      calls.push(`load:${build.revision}`);
      if (failing.has(build.revision)) throw new Error("测试激活失败");
      running = build.revision;
      status = {state: "enabled"};
    },
    async loadInstalled() {
      assert.equal(running, undefined);
      calls.push("restore:installed");
      running = "installed";
      status = {state: "enabled"};
    },
  }, work => work(), () => {});
  development.pause();
  development.start("/plugin");
  return {development, calls, staged, failing,
    get running() {return running;},
    set veto(value) {veto = value;},
    async publish(revision, state = "ready", error) {
      latest = {revision, state, error};
      await development.retry();
    },
  };
}

test("a complete revision replaces only the running plugin and exit restores the installed version", async () => {
  const f = setup({installed: true});
  await f.publish("first");
  assert.equal(f.development.getSnapshot().revision, "first");
  assert.deepEqual(f.calls, ["stage:first", "stop:installed", "load:first", "reopen"]);
  await f.publish("second");
  assert.equal(f.running, "second");
  assert.deepEqual([...f.staged], ["second"]);
  await f.development.stop();
  assert.equal(f.running, "installed");
  assert.equal(f.development.getSnapshot(), null);
  assert.equal(f.staged.size, 0);
});

test("a build error or rejected save keeps the live version, and the same candidate can be retried", async () => {
  const f = setup();
  await f.publish("first");
  await f.publish("first", "error", "测试构建失败");
  assert.equal(f.development.getSnapshot().error, "测试构建失败");
  assert.equal(f.running, "first");
  f.veto = true;
  await f.publish("second");
  assert.match(f.development.getSnapshot().error, /保存被拒绝/);
  assert.equal(f.running, "first");
  assert.equal(f.calls.includes("load:second"), false);
  f.veto = false;
  await f.development.retry();
  assert.equal(f.running, "second");
  assert.equal(f.calls.filter(call => call === "stage:second").length, 1);
  await f.development.stop();
});

test("activation failure reactivates the previous successful development revision", async () => {
  const f = setup();
  await f.publish("first");
  f.failing.add("second");
  await f.publish("second");
  assert.equal(f.running, "first");
  assert.equal(f.development.getSnapshot().revision, "first");
  assert.match(f.development.getSnapshot().error, /测试激活失败/);
  assert.deepEqual(f.calls.slice(-5), ["stage:second", "stop:first", "load:second", "load:first", "reopen"]);
  await f.publish("third");
  assert.equal(f.running, "third");
  assert.deepEqual([...f.staged], ["third"]);
  await f.development.stop();
});
