import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, deferred, flushStartup} from "./helpers/mainStartupFixture.mjs";

async function startWith(plugin) {
  const fixture = createMainFixture({additionalPlugins: [plugin]});
  fixture.start();
  await flushStartup();
  assert.equal(fixture.closeRequestListeners.size, 1);
  return fixture;
}

test("a close requested during startup waits until plugins have started and then stops them", async () => {
  const gate = deferred();
  let activating = false;
  let stopped = false;
  const fixture = createMainFixture({additionalPlugins: [{
    id: "test-slow-start", requires: [], provides: [],
    async activate(context) {
      activating = true;
      context.onStop({withdraw() {stopped = true;}});
      await gate.promise;
    },
  }]});
  fixture.start();
  for (let index = 0; index < 20 && !activating; index++) await flushStartup();
  assert.equal(activating, true);
  assert.equal(fixture.closeRequestListeners.size, 1);
  let finished = false;
  const close = fixture.requestWindowClose().then(result => {finished = true; return result;});
  await flushStartup();
  assert.equal(finished, false);
  assert.equal(stopped, false);
  gate.resolve();
  assert.equal((await close).prevented, true);
  assert.equal(stopped, true);
  assert.equal(fixture.logs.includes("window.destroy"), true);
});

test("a close pending during failed startup is cancelled and its listener is removed", async () => {
  const gate = deferred();
  let activating = false;
  const fixture = createMainFixture({additionalPlugins: [{
    id: "test-failed-start", requires: [], provides: [],
    async activate() {activating = true; await gate.promise; throw new Error("启动失败");},
  }]});
  fixture.start();
  for (let index = 0; index < 20 && !activating; index++) await flushStartup();
  assert.equal(activating, true);
  const close = fixture.requestWindowClose();
  gate.resolve();
  assert.equal((await close).prevented, true);
  await flushStartup();
  assert.equal(fixture.closeRequestListeners.size, 0);
  assert.equal(fixture.logs.includes("window.destroy"), false);
  assert.equal(fixture.body.children.length, 0);
  assert.equal(fixture.rootElement.children[0].children[0].textContent, "应用启动失败");
});

test("a native close waits for plugin withdrawal and rejects concurrent close requests", async () => {
  const gate = deferred();
  let withdrawalStarted = false;
  const fixture = await startWith({
    id: "test-slow-stop", requires: [], provides: [],
    activate(context) {context.onStop({async withdraw() {withdrawalStarted = true; await gate.promise;}});},
  });
  let finished = false;
  const first = fixture.requestWindowClose().then(result => {finished = true; return result;});
  for (let index = 0; index < 20 && !withdrawalStarted; index++) await flushStartup();
  assert.equal(withdrawalStarted, true);
  assert.equal(finished, false);
  assert.equal((await fixture.requestWindowClose()).prevented, true);
  assert.equal(finished, false);
  gate.resolve();
  assert.equal((await first).prevented, true);
  assert.equal(fixture.logs.includes("window.destroy"), true);
});

test("a failed withdrawal leaves a recovery action that retries and then closes the window", async () => {
  let attempts = 0;
  const fixture = await startWith({
    id: "test-retry-stop", requires: [], provides: [],
    activate(context) {context.onStop({withdraw() {if (++attempts === 1) throw new Error("后端仍在保存");}});},
  });
  assert.equal((await fixture.requestWindowClose()).prevented, true);
  assert.equal(fixture.body.children.length, 1);
  const panel = fixture.body.children[0];
  assert.match(panel.children[1].textContent, /后端仍在保存/);
  assert.equal(panel.children[2].textContent, "重试关闭");
  assert.equal(fixture.logs.includes("window.destroy"), false);
  panel.children[2].click();
  await flushStartup();
  assert.equal(attempts, 2);
  assert.equal(fixture.logs.includes("window.destroy"), true);
  assert.equal(fixture.body.children.length, 0);
});

test("a deactivation error is shown and requires a separate action to close", async () => {
  const fixture = await startWith({
    id: "test-failed-deactivation", requires: [], provides: [], activate() {},
    deactivate() {throw new Error("清理失败");},
  });
  assert.equal((await fixture.requestWindowClose()).prevented, true);
  const panel = fixture.body.children[0];
  assert.match(panel.children[1].textContent, /操作未完成/);
  assert.equal(panel.children[2].textContent, "关闭窗口");
  assert.equal(fixture.logs.includes("window.destroy"), false);
  panel.children[2].click();
  await flushStartup();
  assert.equal(fixture.logs.includes("window.destroy"), true);
});

test("a native window destruction error remains visible and can be retried", async () => {
  const fixture = await startWith({id: "test-window-destroy", requires: [], provides: [], activate() {}});
  fixture.faults.destroyError = new Error("窗口关闭失败");
  assert.equal((await fixture.requestWindowClose()).prevented, true);
  assert.match(fixture.body.children[0].children[1].textContent, /窗口关闭失败/);
  fixture.faults.destroyError = undefined;
  fixture.body.children[0].children[2].click();
  await flushStartup();
  assert.equal(fixture.logs.filter(entry => entry === "window.destroy").length, 2);
});
