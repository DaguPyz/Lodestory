import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {prepareCreatePluginPackage} from "../helpers/createPluginPackage.mjs";

const pluginId = "com.example.plugin-development";

describe("插件开发模式", function () {
  let fixture;
  let project;
  let watcher;
  let watcherExit;
  let watcherOutputTail = "";
  let lastDevelopmentSnapshot;
  let projectParent;
  let phase = "fixture setup";
  let pluginImported = false;

  before(async function () {
    this.timeout(180000);
    fixture = await prepareCreatePluginPackage();
    const generated = fixture.run(["--name", "plugin-development", "--frontend", "--type", "process"]);
    assert.equal(generated.status, 0, generated.stderr);
    project = path.join(fixture.consumer, "plugin-development");
    await fixture.installTestDependencies(project);
    const packaged = fixture.runProject(project, "package");
    assert.equal(packaged.status, 0, packaged.stderr + packaged.stdout);
  });

  after(async function () {
    this.timeout(30000);
    if (phase !== "complete") {
      console.error(`[plugin-development] failed at phase: ${phase}; last snapshot: ${JSON.stringify(lastDevelopmentSnapshot)}; npm run dev output tail:\n${watcherOutputTail}`);
    }
    await stopDevelopmentAndWatcher();
    try {await browser.execute(() => window.__lodestoryLifecycleTest.restoreAutosaveTimer());} catch {}
    try {await browser.execute(() => window.__lodestoryLifecycleTest.closeProject());} catch {}
    if (pluginImported) {
      try {await browser.execute(id => window.__lodestoryLifecycleTest.uninstallPlugin(id), pluginId);} catch {}
      pluginImported = false;
    }
    await fixture?.dispose();
  });

  it("保存后重载前后端、保留草稿并在退出时恢复已安装插件", async function () {
    this.timeout(300000);
    await browser.setTimeout({script: 25000});
    phase = "waiting for desktop test bridge";
    await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 25000});

    phase = "importing and enabling installed plugin";
    const release = path.join(project, "release");
    const [archive] = await readdir(release);
    const imported = await browser.execute(packagePath => window.__lodestoryLifecycleTest.importPluginPackage(packagePath), path.join(release, archive));
    pluginImported = true;
    assert.equal(imported.id, pluginId);
    await browser.execute(id => window.__lodestoryLifecycleTest.enablePlugin(id), pluginId);
    await browser.waitUntil(() => browser.execute(id => window.__lodestoryLifecycleTest.pluginStatuses()[id]?.state === "enabled", pluginId), {timeout: 25000});

    phase = "opening project and making a dirty draft";
    projectParent = path.join(fixture.directory, "projects");
    await mkdir(projectParent);
    assert.equal(await browser.execute(parent => window.__lodestoryLifecycleTest.openTemporaryProject(parent), projectParent), true);
    await browser.waitUntil(() => browser.execute(() => {
      const state = window.__lodestoryLifecycleTest.snapshot();
      return !!state.session && !state.busy && !state.loading;
    }), {timeout: 25000});
    await browser.execute(() => window.__lodestoryLifecycleTest.createDocument());
    const editor = await $('[aria-label="纯文本正文"]');
    await editor.waitForDisplayed({timeout: 25000});
    await browser.execute(() => window.__lodestoryLifecycleTest.delayAutosaveForTest());
    await editor.setValue("开发模式需要保留的未保存草稿");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    await browser.execute(() => {
      window.__developmentEditorBefore = document.querySelector('[aria-label="纯文本正文"]');
      window.__developmentRootBefore = document.querySelector("#root").firstElementChild;
    });

    phase = "checking installed plugin baseline";
    const panelSelector = `[data-content-id="${pluginId}.main"]`;
    await browser.execute(id => window.__lodestoryLifecycleTest.showLayoutContent(id + ".main"), pluginId);
    await browser.waitUntil(async () => (await $(panelSelector).getText()).includes("在这里开发你的界面。"), {timeout: 10000});
    await clickAndWaitForBackend(panelSelector, "后端已收到请求");

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    watcher = spawn(npm, ["run", "dev"], {
      cwd: project,
      env: fixture.env,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    watcher.once("exit", code => {watcherExit = code;});
    watcher.once("error", error => {watcherExit = `启动失败：${error.message}`;});
    const captureWatcherOutput = chunk => {
      watcherOutputTail = (watcherOutputTail + chunk.toString()).slice(-6000);
    };
    watcher.stdout?.on("data", captureWatcherOutput);
    watcher.stderr?.on("data", captureWatcherOutput);
    phase = "waiting for first development build and reload";
    await browser.execute(folder => window.__lodestoryLifecycleTest.startDevelopment(folder), project);
    await waitForDevelopment(snapshot => snapshot?.state === "running" && snapshot.id === pluginId, 25000);
    const initialRevision = (await developmentSnapshot()).revision;
    await assertDocumentPreserved(editor);

    phase = "saving frontend and backend changes";
    const panelPath = path.join(project, "frontend", "src", "Panel.tsx");
    const protocolPath = path.join(project, "backend", "src", "protocol.rs");
    const originalPanel = await readFile(panelPath, "utf8");
    const originalProtocol = await readFile(protocolPath, "utf8");
    const updatedPanel = originalPanel
      .replace('response.status === "success" ? "后端已收到请求" : response.error.message', 'response.status === "success" ? "后端：" + (response.result as {message: string}).message : response.error.message')
      .replace("在这里开发你的界面。", "前端已热更新");
    const updatedProtocol = originalProtocol.replace("后端已收到请求", "开发版后端已收到请求");
    assert.notEqual(updatedPanel, originalPanel, "前端模板应包含预期修改点");
    assert.notEqual(updatedProtocol, originalProtocol, "后端模板应包含预期修改点");
    const responsivePanel = updatedPanel.replace("if (!backend) return;", 'if (!backend) return;\n    setResult("请求中…");');
    assert.notEqual(responsivePanel, updatedPanel, "后端请求函数应包含预期修改点");
    await writeFile(panelPath, responsivePanel);
    await writeFile(protocolPath, updatedProtocol);

    phase = "waiting for frontend and backend hot reload";
    const hotRevision = await waitForDevelopment(snapshot => snapshot?.state === "running"
      && snapshot.revision !== initialRevision, 25000);
    await browser.waitUntil(async () => (await $(panelSelector).getText()).includes("前端已热更新"), {timeout: 25000});
    await clickAndWaitForBackend(panelSelector, "开发版后端已收到请求");
    await assertDocumentPreserved(editor);

    phase = "checking compile failure retention";
    const brokenPanel = updatedPanel + '\nconst invalidDevelopmentValue: number = "not a number";\n';
    await writeFile(panelPath, brokenPanel.replace(updatedPanel, responsivePanel));
    await waitForDevelopment(snapshot => snapshot?.state === "error" && snapshot.revision === hotRevision.revision, 25000);
    assert.equal((await $(panelSelector).getText()).includes("前端已热更新"), true, "构建失败时应继续显示上一版界面");
    await clickAndWaitForBackend(panelSelector, "开发版后端已收到请求");
    await assertDocumentPreserved(editor);

    phase = "checking activation rollback";
    const repairedPanel = responsivePanel;
    const originalEntry = await readFile(path.join(project, "frontend", "src", "index.tsx"), "utf8");
    const failingEntry = originalEntry.replace("activate(context) {", 'activate(context) {\n      throw new Error("开发插件初始化失败");');
    assert.notEqual(failingEntry, originalEntry, "入口模板应包含预期修改点");
    await writeFile(panelPath, repairedPanel);
    await writeFile(path.join(project, "frontend", "src", "index.tsx"), failingEntry);
    await waitForDevelopment(snapshot => snapshot?.state === "error"
      && snapshot.revision === hotRevision.revision
      && snapshot.error?.includes("开发插件初始化失败"), 25000);
    await browser.waitUntil(async () => (await $(panelSelector).getText()).includes("前端已热更新"), {timeout: 25000});
    await clickAndWaitForBackend(panelSelector, "开发版后端已收到请求");
    await assertDocumentPreserved(editor);

    phase = "recovering from activation failure";
    const healthyEntry = originalEntry;
    await writeFile(path.join(project, "frontend", "src", "index.tsx"), healthyEntry);
    const recoveredRevision = await waitForDevelopment(snapshot => snapshot?.state === "running"
      && snapshot.revision !== hotRevision.revision, 25000);
    assert.notEqual(recoveredRevision.revision, hotRevision.revision, "修复后应发布新的开发版本");

    phase = "stopping development and restoring installed plugin";
    await browser.execute(() => window.__lodestoryLifecycleTest.stopDevelopment());
    const {snapshot: stoppedSnapshot} = await browser.execute(() => ({snapshot: window.__lodestoryLifecycleTest.developmentSnapshot()}));
    assert.equal(stoppedSnapshot, null);
    await browser.waitUntil(() => browser.execute(id => window.__lodestoryLifecycleTest.pluginStatuses()[id]?.state === "enabled", pluginId), {timeout: 25000});
    const restoredPanel = await $(panelSelector);
    await browser.waitUntil(async () => (await restoredPanel.getText()).includes("在这里开发你的界面。"), {timeout: 25000});
    await clickAndWaitForBackend(panelSelector, "后端已收到请求");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === pluginId)?.enabled, true);
    await assertDocumentPreserved(editor);

    phase = "saving preserved document and closing project";
    await stopWatcher();
    await browser.execute(() => window.__lodestoryLifecycleTest.restoreAutosaveTimer());
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
    assert.equal(await readFile(path.join(projectParent, "生命周期测试", "正文.txt"), "utf8"), "开发模式需要保留的未保存草稿");
    phase = "complete";
  });

  async function developmentSnapshot() {
    const {snapshot} = await browser.execute(() => ({snapshot: window.__lodestoryLifecycleTest.developmentSnapshot()}));
    lastDevelopmentSnapshot = snapshot;
    return lastDevelopmentSnapshot;
  }

  async function waitForDevelopment(predicate, timeout) {
    try {
      await browser.waitUntil(async () => {
        const snapshot = await developmentSnapshot();
        if (watcherExit !== undefined && watcherExit !== 0) {
          throw new Error(`npm run dev 已退出（${watcherExit}）；最后状态：${JSON.stringify(snapshot)}；输出末尾：\n${watcherOutputTail}`);
        }
        return predicate(snapshot);
      }, {timeout, timeoutMsg: "等待插件开发状态超时。"});
    } catch (error) {
      throw new Error(`等待插件开发状态失败；最后状态：${JSON.stringify(lastDevelopmentSnapshot)}；npm run dev 输出末尾：\n${watcherOutputTail}`, {cause: error});
    }
    return developmentSnapshot();
  }

  async function clickAndWaitForBackend(selector, message) {
    const panel = await $(selector);
    await (await panel.$("button=测试后端")).click();
    await browser.waitUntil(async () => (await $(selector).getText()).includes(message), {timeout: 25000});
  }

  async function assertDocumentPreserved(editor) {
    assert.equal(await browser.execute(() => document.querySelector("#root").firstElementChild === window.__developmentRootBefore), true);
    assert.equal(await browser.execute(() => document.querySelector('[aria-label="纯文本正文"]') === window.__developmentEditorBefore), true);
    assert.equal(await editor.getValue(), "开发模式需要保留的未保存草稿");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
  }

  async function stopWatcher() {
    if (!watcher || watcher.exitCode !== null) return;
    const exited = new Promise(resolve => watcher.once("exit", resolve));
    if (process.platform !== "win32" && watcher.pid) {
      try {process.kill(-watcher.pid, "SIGTERM");}
      catch {watcher.kill("SIGTERM");}
    } else watcher.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
    if (watcher.exitCode === null) {
      if (process.platform !== "win32" && watcher.pid) {
        try {process.kill(-watcher.pid, "SIGKILL");}
        catch {watcher.kill("SIGKILL");}
      } else watcher.kill("SIGKILL");
    }
    watcher = undefined;
  }

  async function stopDevelopmentAndWatcher() {
    if (watcher) await stopWatcher();
    try {
      await browser.execute(() => window.__lodestoryLifecycleTest.stopDevelopment());
    } catch {}
  }
});
