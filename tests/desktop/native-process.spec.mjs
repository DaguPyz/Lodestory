import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = path.join(root, "tests", "fixtures", "native-process-c");
const target = path.join(root, ".desktop-e2e", "native-fixture");
const executable = path.join(target, "debug", process.platform === "win32" ? "lodestory-test-plugin-c.exe" : "lodestory-test-plugin-c");

describe("独立 Rust 程序加载", function () {
  it("通过应用中的 A 加载测试 C、调用并退出", async function () {
    const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", path.join(fixtureRoot, "Cargo.toml"), "--target-dir", target], {cwd: root, encoding: "utf8"});
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr);

    await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
    const outcome = await browser.execute(async entry => {
      try { return {ok: true, result: await window.__lodestoryLifecycleTest.testNativeProcess(entry)}; }
      catch (error) { return {ok: false, message: String(error), details: error?.message ?? null}; }
    }, executable);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const result = outcome.result;
    assert.deepEqual(result.success, {
      requestId: "test-1", status: "success", result: {message: "C 已收到请求", params: {text: "来自 A 的请求"}},
    });
    assert.equal(result.error.requestId, "test-2");
    assert.equal(result.error.status, "error");
    assert.equal(result.error.error.code, "PLUGIN_OPERATION_FAILED");
  });
});
