import assert from "node:assert/strict";
import {mkdir, readFile, readdir} from "node:fs/promises";
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
    ]) {
      const generated = fixture.run(["--name", name, ...args]);
      assert.equal(generated.status, 0, generated.stderr);
      const project = path.join(fixture.consumer, name);
      await fixture.installTestDependencies(project);
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
    assert.equal(packages.length, 3);
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.openPluginSettings()), true);
    await browser.waitUntil(async () => (await $$('span=已导入，待加载')).length === 3, {timeout: 10000});
    if (process.env.LODESTORY_UI_SHOT) {
      await browser.pause(300); // Let the existing dialog fade finish before visual inspection.
      await browser.saveScreenshot(process.env.LODESTORY_UI_SHOT);
    }
    assert.equal(await browser.execute(() => window.__editorBeforeImport === document.querySelector('[aria-label="纯文本正文"]')), true);
    assert.equal(await browser.execute(() => window.__rootBeforeImport === document.querySelector("#root").firstElementChild), true);
    assert.equal(await editor.getValue(), "导入插件时保留的正文");
    const duplicate = await browser.execute(async packagePath => {
      try {await window.__lodestoryLifecycleTest.importPluginPackage(packagePath); return null;}
      catch (error) {return String(error);}
    }, paths[0]);
    assert.match(duplicate, /已导入/);
    await $("button=关闭").click();
    assert.equal(await browser.execute(() => window.__lodestoryLifecycleTest.closeProject()), true);
    assert.equal(await readFile(path.join(projectParent, "生命周期测试", "正文.txt"), "utf8"), "导入插件时保留的正文");
  });
});
