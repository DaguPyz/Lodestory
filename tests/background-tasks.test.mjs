import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

test("desktop task requests use the registered Rust command and return its bytes", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();
  const tasks = fixture.getService(fixture.requireSdk("@lodestory/sdk/background-tasks").backgroundTasksKey);
  const data = {assets: [], fields: []};
  const bytes = await tasks.execute("asset-management/validate-and-encode-group", {id: null, data});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), data);
  assert.ok(fixture.tauriCalls.some(call => call.command === "run_background_task"));
});

test("browser task fallback can be removed and unknown tasks fail", async () => {
  const fixture = createMainFixture({tauri: false});
  fixture.start();
  await flushStartup();
  const tasks = fixture.getService(fixture.requireSdk("@lodestory/sdk/background-tasks").backgroundTasksKey);
  const remove = tasks.registerFallback("test/task", () => new Uint8Array([1, 2]));
  assert.deepEqual(Array.from(await tasks.execute("test/task", {})), [1, 2]);
  remove();
  await assert.rejects(tasks.execute("test/task", {}), /未登记/);
});
