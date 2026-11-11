import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {createProject} from "../packages/create-plugin/lib/create-project.mjs";
import {prepareCreatePluginPackage} from "./helpers/createPluginPackage.mjs";

async function create(fixture, name, args) {
  const result = fixture.run(["--name", name, "--id", "com.example." + name, ...args]);
  assert.equal(result.status, 0, result.stderr);
  return path.join(fixture.consumer, name);
}

async function readArchive(project) {
  const entries = await fs.readdir(path.join(project, "release"));
  assert.equal(entries.length, 1);
  const file = path.join(project, "release", entries[0]);
  const bytes = await fs.readFile(file);
  const require = createRequire(path.join(project, "package.json"));
  const zip = await require("jszip").loadAsync(bytes);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  return {file, bytes, zip, manifest};
}

test("the packed npm command creates each optional frontend and backend combination", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    for (const file of [
      "bin/create-plugin.mjs", "lib/create-project.mjs", "templates/project/build.mjs",
      "templates/frontend/index.tsx", "templates/shared/protocol.rs",
      "templates/process/main.rs", "templates/dynamic-library/lib.rs",
    ]) assert.ok(fixture.files.includes(file), file + " is included in the npm package");

    for (const [name, args, frontend, backend] of [
      ["front-only", ["--frontend"], true, null],
      ["only-c", ["--type", "process"], false, "main.rs"],
      ["only-d", ["--type", "dynamic-library"], false, "lib.rs"],
      ["both-c", ["--frontend", "--type", "process"], true, "main.rs"],
      ["both-d", ["--frontend", "--type", "dynamic-library"], true, "lib.rs"],
    ]) {
      const project = await create(fixture, name, args);
      const config = JSON.parse(await fs.readFile(path.join(project, "plugin.json"), "utf8"));
      assert.equal(config.id, "com.example." + name);
      assert.equal(Boolean(config.frontend), frontend);
      assert.equal(Boolean(config.backend), Boolean(backend));
      if (frontend) await fs.access(path.join(project, "frontend", "src", "index.tsx"));
      else await assert.rejects(fs.access(path.join(project, "frontend")), {code: "ENOENT"});
      if (backend) await fs.access(path.join(project, "backend", "src", backend));
      else await assert.rejects(fs.access(path.join(project, "backend")), {code: "ENOENT"});
      await fs.access(path.join(project, "scripts", "build.mjs"));
      await assert.rejects(fs.access(path.join(project, "manifest.json")), {code: "ENOENT"});
    }
    const custom = path.join(fixture.consumer, "custom-location");
    const result = fixture.run(["--type", "process", "--name", "another", "--output", custom]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(custom, "plugin.json"), "utf8")).id, "com.example.another");
  } finally {
    await fixture.dispose();
  }
});

test("the short interactive command collects project composition, backend type and ID", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    const front = fixture.run([], "1\ninteractive-front\ncom.example.front\n");
    assert.equal(front.status, 0, front.stderr);
    const frontConfig = JSON.parse(await fs.readFile(path.join(fixture.consumer, "interactive-front", "plugin.json"), "utf8"));
    assert.equal(frontConfig.id, "com.example.front");
    assert.ok(frontConfig.frontend && !frontConfig.backend);

    const both = fixture.run([], "invalid\n3\n2\nbad name\ninteractive-d\nbad/id\ncom.example.both\n");
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /请输入 1、2 或 3/);
    assert.match(both.stdout, /项目名无效/);
    assert.match(both.stdout, /插件 ID 需要至少两段/);
    const config = JSON.parse(await fs.readFile(path.join(fixture.consumer, "interactive-d", "plugin.json"), "utf8"));
    assert.equal(config.id, "com.example.both");
    assert.equal(config.backend.type, "dynamic-library");
    assert.ok(config.frontend);

    const cancelled = fixture.run([], "2\n1\n");
    assert.notEqual(cancelled.status, 0);
    assert.match(cancelled.stderr, /输入已结束，未创建项目/);
  } finally {
    await fixture.dispose();
  }
});

test("invalid options and existing destinations cannot overwrite user files", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    const existing = path.join(fixture.consumer, "existing");
    await fs.mkdir(existing);
    const original = path.join(existing, "keep.txt");
    await fs.writeFile(original, "keep me");
    for (const args of [
      ["--type", "process", "--name", "../escape"],
      ["--type", "process", "--name", "async"],
      ["--type", "unknown", "--name", "sample"],
      ["--name", "sample"],
      ["--frontend", "--name", "sample", "--id", "bad/id"],
      ["--type", "process", "--name", "sample", "--name", "other"],
      ["--type", "process", "--name", "sample", "--output", existing],
    ]) {
      const result = fixture.run(args);
      assert.notEqual(result.status, 0, args.join(" "));
    }
    assert.equal(await fs.readFile(original, "utf8"), "keep me");
    assert.deepEqual(await fs.readdir(existing), ["keep.txt"]);
    await assert.rejects(fs.access(path.join(fixture.consumer, "sample")), {code: "ENOENT"});
  } finally {
    await fixture.dispose();
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
        if (!file.endsWith(path.join("backend", "src", "main.rs"))) return handle;
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
    await fs.access(path.join(destination, ".gitignore"));
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test("build and package produce consistent ZIPs for frontend, backend and combined projects", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    for (const [name, args, frontend, backend] of [
      ["zip-front", ["--frontend"], true, null],
      ["zip-c", ["--type", "process"], false, "process"],
      ["zip-both", ["--frontend", "--type", "dynamic-library"], true, "dynamic-library"],
    ]) {
      const project = await create(fixture, name, args);
      await fixture.installTestDependencies(project);
      const configPath = path.join(project, "plugin.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      config.id = "com.example.changed-" + name;
      config.name = "更新后的插件";
      if (name === "zip-front") config.version = "0.2.0-rc.1+local";
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
      if (name === "zip-front") {
        const source = path.join(project, "frontend", "src");
        const panel = path.join(source, "Panel.tsx");
        await fs.writeFile(panel, 'import "./skin.css";\n' + await fs.readFile(panel, "utf8"));
        await fs.writeFile(path.join(source, "skin.css"), '.example { background: url("./icon.svg"); }\n');
        await fs.writeFile(path.join(source, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
        await fs.mkdir(path.join(project, "frontend", "assets"));
        await fs.writeFile(path.join(project, "frontend", "assets", "notes.txt"), "example asset");
        const built = fixture.runProject(project, "build");
        assert.equal(built.status, 0, built.stderr + built.stdout);
        const runs = await fs.readdir(path.join(project, "build"));
        assert.equal(runs.length, 1);
        await fs.access(path.join(project, "build", runs[0], "dist", "frontend", "index.js"));
        await assert.rejects(fs.access(path.join(project, "manifest.json")), {code: "ENOENT"});
      }
      const packaged = fixture.runProject(project, "package");
      assert.equal(packaged.status, 0, packaged.stderr + packaged.stdout);
      const {file, bytes, zip, manifest} = await readArchive(project);
      assert.equal(manifest.id, config.id);
      assert.equal(manifest.name, config.name);
      assert.equal(manifest.version, config.version);
      assert.deepEqual(manifest.dependencies, config.dependencies);
      assert.equal(Boolean(manifest.frontend), frontend);
      assert.equal(Boolean(manifest.backend), Boolean(backend));
      assert.equal(zip.file("plugin.json"), null, "developer config is not the delivery manifest");
      if (frontend) {
        assert.equal(manifest.frontend.entry, "dist/frontend/index.js");
        const javascript = await zip.file(manifest.frontend.entry).async("string");
        assert.match(javascript, /@lodestory\/sdk\/layout/);
        assert.match(javascript, /from "react"/);
        assert.ok(Object.keys(zip.files).some(file => file.startsWith("dist/frontend/chunks/")));
        assert.match(javascript, /com\.example\.changed-/);
        if (name === "zip-front") {
          assert.deepEqual(manifest.frontend.styles, ["dist/frontend/index.css"]);
          assert.ok(zip.file(manifest.frontend.styles[0]));
          assert.ok(Object.keys(zip.files).some(file => /^dist\/frontend\/assets\/icon-.+\.svg$/.test(file)));
          assert.equal(await zip.file("dist/frontend/assets/notes.txt").async("string"), "example asset");
        }

        const extracted = path.join(project, "unpacked");
        for (const entry of Object.values(zip.files)) {
          if (entry.dir) continue;
          const destination = path.join(extracted, ...entry.name.split("/"));
          await fs.mkdir(path.dirname(destination), {recursive: true});
          await fs.writeFile(destination, await entry.async("nodebuffer"));
        }
        const module = await import(pathToFileURL(path.join(extracted, ...manifest.frontend.entry.split("/"))).href);
        const sdk = await import(pathToFileURL(path.join(project, "node_modules", "@lodestory", "sdk", "dist", "layout.js")).href);
        const plugin = module.default();
        assert.equal(plugin.id, config.id);
        assert.strictEqual(plugin.requires[0], sdk.layoutKey, "the frontend shares the public SDK key");
        let content;
        let removed = 0;
        plugin.activate({
          get(key) {
            assert.strictEqual(key, sdk.layoutKey);
            return {registerContent(value) { content = value; return () => { removed++; }; }};
          },
          track(handle) { return handle; },
        });
        assert.equal(content.title, config.name);
        assert.equal(content.role, "main");
        assert.ok(content.render({active: true}));
        plugin.deactivate();
        assert.equal(removed, 1);
      } else {
        assert.equal(manifest.compatibility.react, undefined);
        assert.ok(!Object.keys(zip.files).some(file => file.startsWith("dist/frontend/")));
      }
      if (backend) {
        assert.equal(manifest.backend.type, backend);
        const [artifact] = manifest.backend.artifacts;
        assert.ok(artifact.os && artifact.arch && artifact.target);
        assert.ok(zip.file(artifact.entry), "the backend entry points to a file in the ZIP");
        if (backend === "process") assert.ok(zip.file(artifact.entry).unixPermissions & 0o111);
      }
      if (name === "zip-front") {
        const repeated = fixture.runProject(project, "package");
        assert.notEqual(repeated.status, 0);
        assert.match(repeated.stderr, /交付包已存在，未覆盖/);
        assert.deepEqual(await fs.readFile(file), bytes);
      }
    }
  } finally {
    await fixture.dispose();
  }
});

test("packaging rejects an incomplete configuration without producing a manifest", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    const project = await create(fixture, "incomplete", ["--frontend"]);
    await fixture.installTestDependencies(project);
    const file = path.join(project, "plugin.json");
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    config.version = "1.02.3";
    await fs.writeFile(file, JSON.stringify(config));
    const invalidVersion = fixture.runProject(project, "package");
    assert.notEqual(invalidVersion.status, 0);
    assert.match(invalidVersion.stderr, /插件版本必须是有效的语义化版本/);
    config.version = "0.1.0";
    delete config.frontend;
    delete config.compatibility.react;
    await fs.writeFile(file, JSON.stringify(config));
    const result = fixture.runProject(project, "package");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /至少需要前端或后端/);
    await assert.rejects(fs.access(path.join(project, "release")), {code: "ENOENT"});
  } finally {
    await fixture.dispose();
  }
});

test("frontend source entry cannot escape the generated project", async () => {
  const fixture = await prepareCreatePluginPackage();
  try {
    const project = await create(fixture, "unsafe-entry", ["--frontend"]);
    await fixture.installTestDependencies(project);
    const file = path.join(project, "plugin.json");
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    config.frontend.entry = "../../outside.tsx";
    await fs.writeFile(file, JSON.stringify(config));
    const result = fixture.runProject(project, "package");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /前端入口必须是项目内的相对路径/);
    await assert.rejects(fs.access(path.join(project, "release")), {code: "ENOENT"});
  } finally {
    await fixture.dispose();
  }
});
