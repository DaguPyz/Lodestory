import assert from "node:assert/strict";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {prepareCreatePluginPackage} from "../helpers/createPluginPackage.mjs";

describe("导入脚手架生成的插件包", function () {
  let fixture;
  const paths = [];

  before(async function () {
    this.timeout(180000);
    fixture = await prepareCreatePluginPackage();
    for (const [name, args] of [
      ["import-front", ["--frontend"]],
      ["import-process", ["--type", "process"]],
      ["import-combined", ["--frontend", "--type", "dynamic-library"]],
      ["import-combined-process", ["--frontend", "--type", "process"]],
      ["import-failure", ["--frontend"]],
      ["import-page", ["--frontend"]],
      ["import-transaction-failure", ["--frontend"]],
    ]) {
      const generated = fixture.run(["--name", name, ...args]);
      assert.equal(generated.status, 0, generated.stderr);
      const project = path.join(fixture.consumer, name);
      await fixture.installTestDependencies(project);
      if (name === "import-failure") {
        const entry = path.join(project, "frontend/src/index.tsx");
        const source = await readFile(entry, "utf8");
        await writeFile(entry, source.replace("    },\n    deactivate()", "      throw new Error('测试激活失败');\n    },\n    deactivate()"));
      }
      if (name === "import-combined") {
        const panel = path.join(project, "frontend/src/Panel.tsx");
        const source = await readFile(panel, "utf8");
        await writeFile(panel, `import "./panel.css";\n${source.replace('<section aria-hidden', '<section className="plugin-scaffold-e2e" aria-hidden')}`);
        await writeFile(path.join(project, "frontend/src/panel.css"), '.plugin-scaffold-e2e { color: rgb(12, 34, 56); background-image: url("./icon.svg"); }');
        await writeFile(path.join(project, "frontend/src/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z"/></svg>');
      }
      if (name === "import-page") {
        const configPath = path.join(project, "plugin.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.dependencies.requires = [{id: "lodestory/navigation-layout@0", version: "^0.1.0"}];
        await writeFile(configPath, JSON.stringify(config, null, 2));
        await writeFile(path.join(project, "frontend/src/index.tsx"), `import type {Plugin} from "@lodestory/sdk";
import {navigationLayoutKey} from "@lodestory/sdk/navigation-layout";
const testWindow = globalThis as unknown as {__lodestoryTestAllowPluginStop?: boolean};
export default function createPlugin(): Plugin {
  const removers: Array<() => void> = [];
  return {id: __LODESTORY_PLUGIN_ID__, requires: [navigationLayoutKey], provides: [],
    activate(context) {removers.push(context.track(context.get(navigationLayoutKey).registerPage({
      id: __LODESTORY_PLUGIN_ID__ + ".page", navigation: {label: "测试插件页面"}, render: () => <div>外部页面已打开</div>,
    })));
    removers.push(context.track(context.get(navigationLayoutKey).registerPage({
      id: __LODESTORY_PLUGIN_ID__ + ".broken", navigation: {label: "错误插件页面"}, render: () => {throw new Error("测试页面渲染失败");},
    })));
      context.onStop({prepare(scope) {
        if (scope === "plugin" && !testWindow.__lodestoryTestAllowPluginStop) throw new Error("测试保存被拒绝");
      }});
    },
    deactivate() {for (const remove of removers.reverse()) remove();},
  };
}`);
      }
      if (name === "import-transaction-failure") {
        const configPath = path.join(project, "plugin.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.dependencies.requires = [
          {id: "lodestory/layout@0", version: "^0.1.0"},
          {id: "lodestory/navigation-layout@0", version: "^0.1.0"},
        ];
        await writeFile(configPath, JSON.stringify(config, null, 2));
        await writeFile(path.join(project, "frontend/src/index.tsx"), `import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";
import {navigationLayoutKey} from "@lodestory/sdk/navigation-layout";
export default function createPlugin(): Plugin {
  const removers: Array<() => void> = [];
  return {id: __LODESTORY_PLUGIN_ID__, requires: [layoutKey, navigationLayoutKey], provides: [],
    activate(context) {
      removers.push(context.track(context.get(navigationLayoutKey).registerPage({
        id: __LODESTORY_PLUGIN_ID__ + ".page", navigation: {label: "失败事务页面"}, render: () => <div>不应显示</div>,
      })));
      removers.push(context.track(context.get(layoutKey).registerContent({
        id: "workbench.loading", title: "重复内容", role: "status", render: () => <div>不应显示</div>,
      })));
    },
    deactivate() {for (const remove of removers.reverse()) remove();},
  };
}`);
      }
      const built = fixture.runProject(project, "package");
      assert.equal(built.status, 0, built.stderr + built.stdout);
      const [filename] = await readdir(path.join(project, "release"));
      paths.push(path.join(project, "release", filename));
    }
  });

  after(async function () {await fixture?.dispose();});

  it("接收前端、后端和组合包，并在设置中显示待加载状态", async function () {
    this.timeout(90000);
    await browser.waitUntil(() => browser.execute(() => !!window.__lodestoryLifecycleTest), {timeout: 30000});
    const projectParent = path.join(fixture.directory, "projects");
    await mkdir(projectParent);
    assert.equal(await browser.execute(parent => window.__lodestoryLifecycleTest.openTemporaryProject(parent), projectParent), true);
    await browser.waitUntil(() => browser.execute(() => {
      const state = window.__lodestoryLifecycleTest.snapshot();
      return !!state.session && !state.busy && !state.loading;
    }), {timeout: 30000});
    await browser.execute(() => window.__lodestoryLifecycleTest.createDocument());
    const editor = await $('[aria-label="纯文本正文"]');
    await editor.waitForDisplayed({timeout: 30000});
    await editor.setValue("导入插件时保留的正文");
    await browser.execute(() => {
      window.__editorBeforeImport = document.querySelector('[aria-label="纯文本正文"]');
      window.__rootBeforeImport = document.querySelector("#root").firstElementChild;
    });
    for (const filename of paths) {
      const result = await browser.execute(async packagePath => {
        try {return {value: await window.__lodestoryLifecycleTest.importPluginPackage(packagePath)};}
        catch (error) {return {error: String(error)};}
      }, filename);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.value.status, "pending-load");
    }
    const packages = await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages());
    assert.equal(packages.length, 7);
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    await browser.waitUntil(async () => (await $$('span=已导入，待加载')).length === 7, {timeout: 10000});
    if (process.env.LODESTORY_UI_SHOT) {
      await browser.pause(300); // Let the existing dialog fade finish before visual inspection.
      await browser.saveScreenshot(process.env.LODESTORY_UI_SHOT);
    }
    const firstRow = await $(".plugin-settings-row");
    await (await firstRow.$("button=加载")).click();
    await browser.waitUntil(async () => (await firstRow.getText()).includes("已启用"), {timeout: 30000});
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    assert.equal(await browser.execute(() => window.__rootBeforeImport === document.querySelector("#root").firstElementChild), true);
    assert.equal(await editor.getValue(), "导入插件时保留的正文");
    const duplicate = await browser.execute(async packagePath => {
      try {await window.__lodestoryLifecycleTest.importPluginPackage(packagePath); return null;}
      catch (error) {return String(error);}
    }, paths[0]);
    assert.match(duplicate, /已导入/);
    await $("button=关闭").click();
    await browser.execute(() => window.__lodestoryLifecycleTest.delayAutosaveForTest());
    await editor.setValue("加载插件时尚未保存的正文");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    for (const item of packages.filter(item => !["com.example.import-failure", "com.example.import-transaction-failure"].includes(item.id))) {
      const result = await browser.execute(async id => {
        try {await window.__lodestoryLifecycleTest.enablePlugin(id); return null;}
        catch (error) {return String(error);}
      }, item.id);
      assert.equal(result, null, `${item.id}: ${result}`);
    }
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    assert.equal(await browser.execute(() => window.__rootBeforeImport === document.querySelector("#root").firstElementChild), true);
    assert.equal(await editor.getValue(), "加载插件时尚未保存的正文");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    const activationFailure = await browser.execute(async () => {
      try {await window.__lodestoryLifecycleTest.enablePlugin("com.example.import-failure"); return null;}
      catch (error) {return String(error);}
    });
    assert.match(activationFailure, /测试激活失败/);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.layoutContents())).includes("com.example.import-failure.main"), false);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-failure").enabled, false);
    const commitFailure = await browser.execute(async () => {
      try {await window.__lodestoryLifecycleTest.enablePlugin("com.example.import-transaction-failure"); return null;}
      catch (error) {return String(error);}
    });
    assert.match(commitFailure, /already registered/);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-transaction-failure").enabled, false);
    const pageAfterRollback = await browser.execute(async () => {
      try {await window.__lodestoryLifecycleTest.openPage("com.example.import-transaction-failure.page"); return null;}
      catch (error) {return String(error);}
    });
    assert.match(pageAfterRollback, /not registered/);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    await browser.execute(() => window.__lodestoryLifecycleTest.restoreAutosaveTimer());
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    const openBroken = await $("button=打开错误插件页面");
    await openBroken.waitForExist({timeout: 10000});
    await openBroken.scrollIntoView();
    await openBroken.click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("插件界面显示失败"), {timeout: 10000});
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    const back = await $('.ui-page:not([hidden]) button[aria-label="返回上一页"]');
    await back.click();
    await editor.waitForDisplayed({timeout: 10000});
    assert.equal(await editor.getValue(), "加载插件时尚未保存的正文");
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    const openPage = await $("button=打开测试插件页面");
    await openPage.waitForExist({timeout: 10000});
    await openPage.scrollIntoView();
    await browser.execute(() => window.__lodestoryLifecycleTest.delayAutosaveForTest());
    await editor.setValue("停用时保留的正文");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    await openPage.click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("外部页面已打开"), {timeout: 10000});
    const vetoedDisable = await browser.execute(async () => {
      try {await window.__lodestoryLifecycleTest.disablePlugin("com.example.import-page"); return null;}
      catch (error) {return String(error);}
    });
    assert.match(vetoedDisable, /测试保存被拒绝/);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-page").enabled, true);
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()))["com.example.import-page"].state, "stop-error");
    assert.equal((await $("body").getText()).includes("外部页面已打开"), true);
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    assert.equal(await editor.getValue(), "停用时保留的正文");
    await browser.execute(() => {globalThis.__lodestoryTestAllowPluginStop = true;});
    await browser.execute(() => window.__lodestoryLifecycleTest.disablePlugin("com.example.import-page"));
    await browser.waitUntil(() => browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"]?.state === "disabled"), {timeout: 30000});
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-page").enabled, false);
    await editor.waitForDisplayed({timeout: 10000});
    assert.equal(await browser.execute(() => window.__rootBeforeImport === document.querySelector("#root").firstElementChild), true);
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    assert.equal(await editor.getValue(), "停用时保留的正文");
    await browser.execute(() => window.__lodestoryLifecycleTest.restoreAutosaveTimer());
    await browser.execute(() => window.__lodestoryLifecycleTest.enablePlugin("com.example.import-page"));
    await browser.waitUntil(() => browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"]?.state === "enabled"), {timeout: 30000});
    assert.ok((await browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"].pages)).some(page => page.id === "com.example.import-page.page"));
    await browser.execute(() => window.__lodestoryLifecycleTest.openPage("com.example.import-page.page"));
    await browser.waitUntil(async () => (await $("body").getText()).includes("外部页面已打开"), {timeout: 10000});
    await (await $('.ui-page:not([hidden]) button[aria-label="返回上一页"]')).click();
    await editor.waitForDisplayed({timeout: 10000});
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    await browser.execute(() => window.__lodestoryLifecycleTest.delayAutosaveForTest());
    await editor.setValue("停用后端插件时保留的正文");
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
    for (const id of ["com.example.import-combined", "com.example.import-combined-process"]) {
      await browser.execute(pluginId => window.__lodestoryLifecycleTest.showLayoutContent(pluginId + ".main"), id);
      const panel = await $(`[data-content-id="${id}.main"]`);
      const button = await panel.$("button=测试后端");
      await button.waitForDisplayed({timeout: 10000});
      await button.click();
      await browser.waitUntil(async () => (await panel.getText()).includes("后端已收到请求"), {timeout: 10000});
      if (id === "com.example.import-combined") {
        assert.equal(await browser.execute(pluginId => getComputedStyle(document.querySelector(`[data-content-id="${pluginId}.main"] .plugin-scaffold-e2e`)).color, id), "rgb(12, 34, 56)");
      }
      await browser.execute(pluginId => window.__lodestoryLifecycleTest.disablePlugin(pluginId), id);
      await browser.waitUntil(() => browser.execute(pluginId => window.__lodestoryLifecycleTest.pluginStatuses()[pluginId]?.state === "disabled", id), {timeout: 30000});
      assert.equal(await browser.execute(() => window.__rootBeforeImport === document.querySelector("#root").firstElementChild), true);
      assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
      assert.equal(await editor.getValue(), "停用后端插件时保留的正文");
      assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.fileState())).dirty, true);
      await browser.execute(pluginId => window.__lodestoryLifecycleTest.enablePlugin(pluginId), id);
      await browser.waitUntil(() => browser.execute(pluginId => window.__lodestoryLifecycleTest.pluginStatuses()[pluginId]?.state === "enabled", id), {timeout: 30000});
      await browser.execute(pluginId => window.__lodestoryLifecycleTest.showLayoutContent(pluginId + ".main"), id);
      const restoredPanel = await $(`[data-content-id="${id}.main"]`);
      const restoredButton = await restoredPanel.$("button=测试后端");
      await restoredButton.waitForDisplayed({timeout: 10000});
      await restoredButton.click();
      await browser.waitUntil(async () => (await restoredPanel.getText()).includes("后端已收到请求"), {timeout: 10000});
    }
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    await browser.execute(() => window.__lodestoryLifecycleTest.restoreAutosaveTimer());
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
    assert.equal(await readFile(path.join(projectParent, "生命周期测试", "正文.txt"), "utf8"), "停用后端插件时保留的正文");
    const pageEntry = await $('button[aria-label="测试插件页面"]');
    await pageEntry.waitForDisplayed({timeout: 10000});
    await pageEntry.click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("外部页面已打开"), {timeout: 10000});
    await browser.execute(() => window.__lodestoryLifecycleTest.stopRuntime());
    await browser.execute(() => {window.__beforePluginReload = true;});
    await browser.refresh();
    await browser.waitUntil(() => browser.execute(() => !window.__beforePluginReload && !!window.__lodestoryLifecycleTest), {timeout: 30000});
    await browser.waitUntil(() => browser.execute(() => {
      const states = window.__lodestoryLifecycleTest?.pluginStatuses() ?? {};
      return ["com.example.import-front", "com.example.import-process", "com.example.import-combined", "com.example.import-combined-process", "com.example.import-page"]
        .every(id => states[id]?.state === "enabled");
    }), {timeout: 30000, timeoutMsg: "重启后插件未恢复启用"});
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()))["com.example.import-failure"], undefined);

    await browser.execute(() => window.__lodestoryLifecycleTest.openPage("com.example.import-page.page"));
    await browser.waitUntil(async () => (await $("body").getText()).includes("外部页面已打开"), {timeout: 10000});
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    async function findPluginAction(id, label) {
      await browser.waitUntil(async () => {
        for (const row of await $$(".plugin-settings-row")) {
          if (!(await row.getText()).includes(id)) continue;
          if (await (await row.$(`button=${label}`)).isExisting()) return true;
        }
        return false;
      }, {timeout: 10000, timeoutMsg: `插件列表中没有 ${id}`});
      for (const row of await $$(".plugin-settings-row")) {
        if ((await row.getText()).includes(id)) {
          const button = await row.$(`button=${label}`);
          if (await button.isExisting()) return button;
        }
      }
      throw new Error(`找不到插件 ${id} 的管理行`);
    }
    await browser.execute(() => {window.__rootBeforeDisable = document.querySelector("#root").firstElementChild;});
    await browser.execute(() => {globalThis.__lodestoryTestAllowPluginStop = true;});
    const disableButton = await findPluginAction("com.example.import-page", "停用");
    await disableButton.scrollIntoView();
    await disableButton.click();
    await browser.waitUntil(() => browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"]?.state === "disabled"), {timeout: 30000});
    assert.equal((await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-page").enabled, false);
    assert.equal(await browser.execute(() => document.querySelector("#root").firstElementChild === window.__rootBeforeDisable), true);
    await browser.execute(() => window.__lodestoryLifecycleTest.stopRuntime());
    await browser.execute(() => {window.__beforeDisableReload = true;});
    await browser.refresh();
    await browser.waitUntil(() => browser.execute(() => !window.__beforeDisableReload && !!window.__lodestoryLifecycleTest), {timeout: 30000});
    await browser.waitUntil(() => browser.execute(async () => {
      const packages = await window.__lodestoryLifecycleTest.listPluginPackages();
      return window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-front"]?.state === "enabled"
        && packages.find(item => item.id === "com.example.import-page")?.enabled === false
        && packages.find(item => item.id === "com.example.import-page")?.disabled === true
        && window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"]?.state !== "enabled";
    }), {timeout: 30000, timeoutMsg: "停用插件在重新启动后被错误恢复"});
    await browser.execute(() => {globalThis.__lodestoryTestAllowPluginStop = true;});
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    const enableButton = await findPluginAction("com.example.import-page", "启用");
    await enableButton.scrollIntoView();
    await enableButton.click();
    await browser.waitUntil(() => browser.execute(() => window.__lodestoryLifecycleTest.pluginStatuses()["com.example.import-page"]?.state === "enabled"), {timeout: 30000});

    await browser.execute(() => {window.__rootBeforeUninstall = document.querySelector("#root").firstElementChild;});
    const uninstallButton = await findPluginAction("com.example.import-front", "卸载");
    await uninstallButton.scrollIntoView();
    await uninstallButton.click();
    await browser.waitUntil(() => browser.execute(async () => !(await window.__lodestoryLifecycleTest.listPluginPackages()).some(item => item.id === "com.example.import-front")), {timeout: 30000});
    await browser.waitUntil(async () => {
      for (const row of await $$(".plugin-settings-row")) if ((await row.getText()).includes("com.example.import-front")) return false;
      return true;
    }, {timeout: 10000, timeoutMsg: "卸载后插件仍显示在管理列表中"});
    assert.equal(await browser.execute(() => document.querySelector("#root").firstElementChild === window.__rootBeforeUninstall), true);
    const reimported = await browser.execute(packagePath => window.__lodestoryLifecycleTest.importPluginPackage(packagePath), paths[0]);
    assert.equal(reimported.id, "com.example.import-front");
    const reimportedRecord = (await browser.execute(() => window.__lodestoryLifecycleTest.listPluginPackages())).find(item => item.id === "com.example.import-front");
    assert.equal(reimportedRecord.enabled, false);
    assert.notEqual(reimportedRecord.disabled, true);
    await browser.waitUntil(async () => {
      for (const row of await $$(".plugin-settings-row")) if ((await row.getText()).includes("com.example.import-front")) return true;
      return false;
    }, {timeout: 10000, timeoutMsg: "重新导入后插件没有返回管理列表"});
  });
});
