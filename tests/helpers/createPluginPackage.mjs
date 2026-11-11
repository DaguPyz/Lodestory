import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {access, cp, copyFile, mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const packageRoot = fileURLToPath(new URL("../../packages/create-plugin/", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, cwd, env, input) {
  const result = spawnSync(npm, args, {cwd, env, input, encoding: "utf8", shell: process.platform === "win32"});
  if (result.error) throw result.error;
  return result;
}

/** Pack the real npm package and install it in an isolated consumer project. */
export async function prepareCreatePluginPackage() {
  const directory = await mkdtemp(path.join(tmpdir(), "lodestory-create-plugin-"));
  try {
    const consumer = path.join(directory, "consumer");
    await mkdir(consumer);
    const npmrc = path.join(directory, "npmrc");
    await writeFile(npmrc, "");
    const env = {
      ...process.env,
      npm_config_cache: path.join(directory, "npm-cache"),
      npm_config_userconfig: npmrc,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      CARGO_TARGET_DIR: path.join(directory, "cargo-target"),
    };
    const packed = run(["pack", "--json", "--pack-destination", directory], packageRoot, env);
    assert.equal(packed.status, 0, packed.stderr);
    const [metadata] = JSON.parse(packed.stdout);
    const archive = path.join(directory, metadata.filename);
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({private: true}));
    const installed = run(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", archive], consumer, env);
    assert.equal(installed.status, 0, installed.stderr);
    return {
      directory,
      consumer,
      env,
      files: metadata.files.map(file => file.path),
      run(args, input) { return run(["exec", "--offline", "--", "@lodestory/create-plugin", ...args], consumer, env, input); },
      runProject(project, script) { return run(["run", script], project, env); },
      async installTestDependencies(project) { await installTestDependencies(project); },
      async dispose() { await rm(directory, {recursive: true, force: true}); },
    };
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

/** Use installed third-party tools and a copy of the public SDK build while it is unpublished. */
async function installTestDependencies(project) {
  const modules = path.join(project, "node_modules");
  await mkdir(modules, {recursive: true});
  for (const [name, version] of [
    ["esbuild", "0.28.2"], ["jszip", "3.10.2"], ["semver", "7.8.6"],
    ["react", null], ["typescript", null], ["@types/react", null],
  ]) {
    let source = path.join(repository, "node_modules", ...name.split("/"));
    try { await access(source); }
    catch {
      const store = path.join(repository, "node_modules", ".pnpm");
      const prefix = name.replace("/", "+") + "@" + version;
      const entry = (await readdir(store)).find(item => item === prefix || item.startsWith(prefix + "_"));
      if (!entry) throw new Error("Test dependency is not installed: " + name);
      source = path.join(store, entry, "node_modules", ...name.split("/"));
    }
    const target = path.join(modules, ...name.split("/"));
    await mkdir(path.dirname(target), {recursive: true});
    await symlink(await realpath(source), target, process.platform === "win32" ? "junction" : "dir");
  }
  const sdk = path.join(modules, "@lodestory", "sdk");
  await mkdir(sdk, {recursive: true});
  await copyFile(path.join(repository, "packages", "sdk", "package.json"), path.join(sdk, "package.json"));
  await cp(path.join(repository, "packages", "sdk", "dist"), path.join(sdk, "dist"), {recursive: true});
}
