import assert from "node:assert/strict";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {prepareCreatePluginPackage} from "../helpers/createPluginPackage.mjs";

describe("npm 脚手架生成的插件包", function () {
  let fixture;
  const entries = {};

  before(async function () {
    this.timeout(120000);
    fixture = await prepareCreatePluginPackage();
    for (const [type, name] of [["process", "my-c"], ["dynamic-library", "my-d"]]) {
      const generated = fixture.run(["--type", type, "--name", name]);
      assert.equal(generated.status, 0, generated.stderr);
      const project = path.join(fixture.consumer, name);
      await fixture.installTestDependencies(project);
      const packaged = fixture.runProject(project, "package");
      assert.equal(packaged.status, 0, packaged.stderr + packaged.stdout);
      const [filename] = await readdir(path.join(project, "release"));
      const require = createRequire(path.join(project, "package.json"));
      const zip = await require("jszip").loadAsync(await readFile(path.join(project, "release", filename)));
      const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
      const artifact = manifest.backend.artifacts[0];
      assert.equal(manifest.backend.type, type);
      const entry = path.join(fixture.directory, "unpacked", name, ...artifact.entry.split("/"));
      await mkdir(path.dirname(entry), {recursive: true});
      await writeFile(entry, await zip.file(artifact.entry).async("nodebuffer"), {mode: type === "process" ? 0o755 : 0o644});
      entries[type] = entry;
    }
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
