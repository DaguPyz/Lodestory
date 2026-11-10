import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const packageRoot = fileURLToPath(new URL("../../packages/create-plugin/", import.meta.url));
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
      async dispose() { await rm(directory, {recursive: true, force: true}); },
    };
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}
