import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = path.join(root, "tests", "fixtures", "native-library-d");
const libraryName = process.platform === "win32" ? "lodestory_test_library_d.dll"
  : process.platform === "darwin" ? "liblodestory_test_library_d.dylib" : "liblodestory_test_library_d.so";
function build(feature) {
  const target = path.join(root, ".desktop-e2e", `native-library-${feature || "normal"}`);
  const args = ["build", "--locked", "--manifest-path", path.join(fixtureRoot, "Cargo.toml"), "--target-dir", target];
  if (feature) args.push("--features", feature);
  const result = spawnSync("cargo", args, {cwd: root, encoding: "utf8"});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return path.join(target, "debug", libraryName);
}

describe("动态库加载插件 B", function () {
  let library, incompatible, failedInit;
  before(function () {library = build(); incompatible = build("incompatible-abi"); failedInit = build("fail-init");});

  it("在桌面应用中加载、调用和退出真实 Rust 动态库", async function () {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-native-library-"));
    const marker = path.join(parent, "cleaned");
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
      const outcome = await browser.execute(async (entry, markerPath) => {
        try {return {ok: true, result: await window.__lodestoryLifecycleTest.testNativeLibrary(entry, markerPath)};}
        catch (error) {return {ok: false, message: String(error), detail: error?.message ?? null};}
      }, library, marker);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      const result = outcome.result;
      assert.deepEqual(result.success, {requestId: "lib-1", status: "success", result: {message: "D 已收到请求", params: {text: "来自 B 的请求"}}});
      assert.equal(result.error.status, "error");
      assert.equal(result.error.error.code, "PLUGIN_OPERATION_FAILED");
      assert.equal(result.completed.requestId, "lib-4");
      assert.match(result.afterClose, /停止|退出/);
      assert.equal(await readFile(marker, "utf8"), "D 已清理");
    } finally {await rm(parent, {recursive: true, force: true});}
  });

  it("拒绝版本不匹配或初始化失败的动态库", async function () {
    const incompatibleError = await browser.execute(entry => window.__lodestoryLifecycleTest.tryNativeLibraryLoad(entry), incompatible);
    assert.match(incompatibleError, /ABI 版本不兼容/);
    const initError = await browser.execute(entry => window.__lodestoryLifecycleTest.tryNativeLibraryLoad(entry), failedInit);
    assert.match(initError, /初始化失败/);
  });
});
