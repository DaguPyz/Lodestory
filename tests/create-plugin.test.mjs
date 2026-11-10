import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {createProject} from "../packages/create-plugin/lib/create-project.mjs";
import {prepareCreatePluginPackage} from "./helpers/createPluginPackage.mjs";

test("the packed npm command generates both standalone backend projects", async () => {
  const packageFixture = await prepareCreatePluginPackage();
  try {
    for (const name of [
      "bin/create-plugin.mjs", "lib/create-project.mjs", "templates/shared/protocol.rs",
      "templates/process/main.rs", "templates/dynamic-library/lib.rs",
    ]) assert.ok(packageFixture.files.includes(name), name + " is included in the npm package");

    for (const [type, name, entry] of [
      ["process", "my-c", "main.rs"],
      ["dynamic-library", "my-d", "lib.rs"],
    ]) {
      const result = packageFixture.run(["--type", type, "--name", name]);
      assert.equal(result.status, 0, result.stderr);
      const project = path.join(packageFixture.consumer, name);
      const manifest = await fs.readFile(path.join(project, "Cargo.toml"), "utf8");
      const readme = await fs.readFile(path.join(project, "README.md"), "utf8");
      assert.match(manifest, new RegExp('name = "' + name + '"'));
      assert.ok(!manifest.includes("__PROJECT_NAME__"));
      assert.ok(!readme.includes("__PROJECT_NAME__") && !readme.includes("__LIBRARY_NAME__"));
      assert.equal((await fs.readFile(path.join(project, ".gitignore"), "utf8")).trim(), "/target");
      assert.ok((await fs.readFile(path.join(project, "src", entry), "utf8")).length > 0);
      assert.ok((await fs.readFile(path.join(project, "src", "protocol.rs"), "utf8")).length > 0);
    }
    const custom = path.join(packageFixture.consumer, "custom-location");
    const result = packageFixture.run(["--type", "process", "--name", "another", "--output", custom]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await fs.readFile(path.join(custom, "Cargo.toml"), "utf8"), /name = "another"/);
  } finally {
    await packageFixture.dispose();
  }
});

test("the packed command creates either backend through the short interactive invocation", async () => {
  const packageFixture = await prepareCreatePluginPackage();
  try {
    const processResult = packageFixture.run([], "1\ninteractive-c\n");
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.match(await fs.readFile(path.join(packageFixture.consumer, "interactive-c", "Cargo.toml"), "utf8"),
      /name = "interactive-c"/);
    await fs.access(path.join(packageFixture.consumer, "interactive-c", "src", "main.rs"));

    const libraryResult = packageFixture.run([], "invalid\n2\nbad name\ninteractive-d\n");
    assert.equal(libraryResult.status, 0, libraryResult.stderr);
    assert.match(libraryResult.stdout, /请输入 1 或 2/);
    assert.match(libraryResult.stdout, /项目名无效/);
    await fs.access(path.join(packageFixture.consumer, "interactive-d", "src", "lib.rs"));

    const cancelled = packageFixture.run([], "1\n");
    assert.notEqual(cancelled.status, 0);
    assert.match(cancelled.stderr, /输入已结束，未创建项目/);
  } finally {
    await packageFixture.dispose();
  }
});

test("invalid options and existing destinations cannot overwrite user files", async () => {
  const packageFixture = await prepareCreatePluginPackage();
  try {
    const existing = path.join(packageFixture.consumer, "existing");
    await fs.mkdir(existing);
    const original = path.join(existing, "keep.txt");
    await fs.writeFile(original, "keep me");
    for (const args of [
      ["--type", "process", "--name", "../escape"],
      ["--type", "process", "--name", "async"],
      ["--type", "unknown", "--name", "sample"],
      ["--type", "process", "--name", "sample", "--name", "other"],
      ["--type", "process", "--name", "sample", "--output", existing],
    ]) {
      const result = packageFixture.run(args);
      assert.notEqual(result.status, 0, args.join(" "));
    }
    assert.equal(await fs.readFile(original, "utf8"), "keep me");
    assert.deepEqual(await fs.readdir(existing), ["keep.txt"]);
    await assert.rejects(fs.access(path.join(packageFixture.consumer, "sample")), {code: "ENOENT"});
  } finally {
    await packageFixture.dispose();
  }
});

test("a write failure cleans the files it created and reports any cleanup failure", async () => {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "lodestory-create-failure-"));
  try {
    const destination = path.join(parent, "my-c");
    const failWrite = {
      ...fs,
      async open(file, ...args) {
        const handle = await fs.open(file, ...args);
        if (!file.endsWith(path.join("src", "main.rs"))) return handle;
        return {
          async writeFile(content, ...options) {
            await handle.writeFile(content.slice(0, 16), ...options);
            throw new Error("模拟写入失败");
          },
          close() { return handle.close(); },
        };
      },
    };
    await assert.rejects(createProject({type: "process", name: "my-c", output: destination}, failWrite), /模拟写入失败.*已清理/);
    await assert.rejects(fs.access(destination), {code: "ENOENT"});

    const failCleanup = {
      ...failWrite,
      async unlink(file) {
        if (file.endsWith(".gitignore")) throw new Error("模拟清理失败");
        return fs.unlink(file);
      },
    };
    await assert.rejects(createProject({type: "process", name: "my-c", output: destination}, failCleanup),
      error => /未能清理的路径/.test(error.message) && error.message.includes(path.join(destination, ".gitignore")));
    assert.equal((await fs.readFile(path.join(destination, ".gitignore"), "utf8")).trim(), "/target");
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});
