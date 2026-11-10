import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = path.join(root, "tests", "fixtures", "native-process-c");
const target = path.join(root, ".desktop-e2e", "native-fixture");
const executable = path.join(target, "debug", process.platform === "win32" ? "lodestory-test-plugin-c.exe" : "lodestory-test-plugin-c");

describe("独立 Rust 程序的窗口关闭", function () {
  before(function () {
    const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", path.join(fixtureRoot, "Cargo.toml"), "--target-dir", target], {cwd: root, encoding: "utf8"});
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr);
  });
  it("窗口关闭等待后端退出，失败后保留提示并可重试", async function () {
    const parent = await mkdtemp(path.join(tmpdir(), "lodestory-native-close-"));
    const marker = path.join(parent, "backend-exited");
    let pid;
    try {
      await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
      assert.equal(await browser.execute(path => window.__lodestoryLifecycleTest.openTemporaryProject(path), parent), true);
      await browser.waitUntil(() => browser.execute(() => {
        const state = window.__lodestoryLifecycleTest.snapshot();
        return !!state.session && !state.busy && !state.loading;
      }), {timeout: 30000});
      await browser.execute(() => window.__lodestoryLifecycleTest.createDocument());
      const editor = await $('[aria-label="纯文本正文"]');
      await editor.waitForDisplayed({timeout: 30000});
      await editor.setValue("关闭失败时已保存的正文");

      const configured = await browser.execute((entry, markerPath) =>
        window.__lodestoryLifecycleTest.startNativeProcessForClose(entry, markerPath), executable, marker);
      assert.equal(configured.status, "success");
      pid = configured.result.pid;
      // 真实关闭请求仍经过原生窗口；拦住最终销毁以便 WebDriver 完成会话。
      await browser.execute(() => window.__lodestoryLifecycleTest.holdWindowDestroy());
      await browser.execute(() => window.__lodestoryLifecycleTest.requestWindowClose());
      const notice = await $(".app-shutdown-error");
      await notice.waitForDisplayed({timeout: 30000});
      assert.match(await notice.getText(), /模拟后端清理失败/);
      assert.equal(await readFile(path.join(parent, "生命周期测试", "正文.txt"), "utf8"), "关闭失败时已保存的正文");
      process.kill(pid, 0);
      await assert.rejects(readFile(marker), error => error.code === "ENOENT");

      const retry = await $(".app-shutdown-error button");
      assert.equal(await retry.getText(), "重试关闭");
      await retry.click();
      let markerContent;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { markerContent = await readFile(marker, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (markerContent) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(markerContent, String(pid));
      let exited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") { exited = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(exited, true, "A waits for the real Rust process to exit");
      await browser.waitUntil(() => browser.execute(() => window.__lodestoryLifecycleTest.destroyCalls() === 1), {timeout: 10000});
      await browser.execute(() => window.__lodestoryLifecycleTest.restoreWindowDestroy());
      pid = undefined;
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await rm(parent, {recursive: true, force: true});
    }
  });
});
