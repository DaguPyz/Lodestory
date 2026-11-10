import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {prepareCreatePluginPackage} from "../helpers/createPluginPackage.mjs";

describe("npm 脚手架生成的后端", function () {
  let fixture;
  const entries = {};

  before(async function () {
    this.timeout(120000);
    fixture = await prepareCreatePluginPackage();
    const target = path.join(fixture.directory, "target");
    for (const [type, name] of [["process", "my-c"], ["dynamic-library", "my-d"]]) {
      const generated = fixture.run(["--type", type, "--name", name]);
      assert.equal(generated.status, 0, generated.stderr);
      const manifest = path.join(fixture.consumer, name, "Cargo.toml");
      const build = spawnSync("cargo", ["build", "--manifest-path", manifest, "--target-dir", target], {
        cwd: fixture.consumer, env: fixture.env, encoding: "utf8",
      });
      if (build.error) throw build.error;
      assert.equal(build.status, 0, build.stderr);
    }
    entries.process = path.join(target, "debug", process.platform === "win32" ? "my-c.exe" : "my-c");
    const library = process.platform === "win32" ? "my_d.dll"
      : process.platform === "darwin" ? "libmy_d.dylib" : "libmy_d.so";
    entries["dynamic-library"] = path.join(target, "debug", library);
  });

  after(async function () {
    await fixture?.dispose();
  });

  for (const [type, loader] of [["process", "A"], ["dynamic-library", "B"]]) {
    it("通过 " + loader + " 加载、调用并退出生成的后端", async function () {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
      const outcome = await browser.execute(async (kind, entry) => {
        try {return {ok: true, result: await window.__lodestoryLifecycleTest.testScaffoldBackend(kind, entry)};}
        catch (error) {return {ok: false, message: String(error), detail: error?.message ?? null};}
      }, type, entries[type]);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.deepEqual(outcome.result.success, {
        requestId: "scaffold-1", status: "success",
        result: {message: "后端已收到请求", params: {text: "来自桌面测试"}},
      });
      assert.equal(outcome.result.error.requestId, "scaffold-2");
      assert.equal(outcome.result.error.status, "error");
      assert.equal(outcome.result.error.error.code, "PLUGIN_OPERATION_FAILED");
      assert.match(outcome.result.afterClose, /停止|退出/);
    });
  }
});
