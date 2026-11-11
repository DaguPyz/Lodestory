import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import semver from "semver";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const action = process.argv[2];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function validVersion(value) {
  return nonempty(value) && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.test(value)
    && semver.valid(value) !== null;
}

// The initial shared package contract accepts full exact or caret versions.
// Keeping the syntax small ensures the Rust host and npm use the same meaning.
function validRange(value) {
  if (!nonempty(value)) return false;
  const version = value.startsWith("^") ? value.slice(1) : value;
  return !version.includes("+") && validVersion(version) && semver.validRange(value) !== null;
}

function validPluginId(value) {
  return nonempty(value) && value.length <= 200
    && /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+$/.test(value);
}

function validCapabilityId(value) {
  return nonempty(value) && value.length <= 200 && /^[A-Za-z0-9._/@-]+$/.test(value);
}

function portablePath(value) {
  if (!value || Buffer.byteLength(value) > 4096 || value.startsWith("/") || /[\\:\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  return value.split("/").every(part => part && part !== "." && part !== ".."
    && Buffer.byteLength(part) <= 255 && !/[. ]$/.test(part)
    && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

function validate(config) {
  if (!object(config)) throw new Error("plugin.json 必须是对象。");
  if (!validPluginId(config.id)) {
    throw new Error("插件 ID 需要至少两段，并以点分隔。");
  }
  if (!nonempty(config.name) || Buffer.byteLength(config.name) > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(config.name)) {
    throw new Error("插件名称无效。");
  }
  if (!validVersion(config.version)) throw new Error("插件版本必须是有效的语义化版本。");
  if (config.description !== undefined && (typeof config.description !== "string" || Buffer.byteLength(config.description) > 16384)) {
    throw new Error("插件说明必须是字符串。");
  }
  if (!object(config.compatibility) || !nonempty(config.compatibility.hostApi)
      || !validRange(config.compatibility.hostApi)) {
    throw new Error("必须声明有效的宿主接口版本范围。");
  }
  if (config.frontend !== undefined) {
    if (!object(config.frontend) || !nonempty(config.frontend.entry)
        || !nonempty(config.compatibility.react) || !validRange(config.compatibility.react)) {
      throw new Error("前端须声明源代码入口和有效的 React 版本范围。");
    }
  } else if (config.compatibility.react !== undefined) {
    throw new Error("没有前端时不能声明 React 版本范围。");
  }
  if (config.backend !== undefined && (!object(config.backend)
      || !["process", "dynamic-library"].includes(config.backend.type))) {
    throw new Error("后端类型必须是 process 或 dynamic-library。");
  }
  if (!config.frontend && !config.backend) throw new Error("插件至少需要前端或后端。");
  if (!object(config.dependencies)) throw new Error("必须声明插件和能力依赖。");
  for (const name of ["plugins", "requires", "provides"]) {
    const entries = config.dependencies[name];
    if (!Array.isArray(entries)) throw new Error("dependencies." + name + " 必须是数组。");
    const seen = new Set();
    for (const item of entries) {
      if (!object(item) || !(name === "plugins" ? validPluginId(item.id) : validCapabilityId(item.id)) || !nonempty(item.version)
          || !(name === "provides" ? validVersion(item.version) : validRange(item.version))
          || seen.has(item.id)) {
        throw new Error("dependencies." + name + " 含无效或重复的声明。");
      }
      seen.add(item.id);
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  if (result.error) throw new Error("无法运行 " + command + "：" + result.error.message, {cause: result.error});
  if (result.status !== 0) {
    throw new Error(command + " 运行失败：\n" + (result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

async function frontendFiles(config) {
  const entry = config.frontend.entry;
  const segments = entry.split("/");
  if (entry.includes("\\") || path.posix.isAbsolute(entry)
      || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("前端入口必须是项目内的相对路径。");
  }
  const realRoot = await fs.realpath(root);
  const realEntry = await fs.realpath(path.join(root, ...segments));
  const frontendSource = await fs.realpath(path.join(root, "frontend", "src"));
  if (!realEntry.startsWith(realRoot + path.sep) || !realEntry.startsWith(frontendSource + path.sep)) {
    throw new Error("前端入口必须位于 frontend/src 目录内。");
  }

  let tsc;
  try { tsc = require.resolve("typescript/bin/tsc"); }
  catch { throw new Error("缺少前端构建依赖，请先运行 npm install。"); }
  run(process.execPath, [tsc, "--project", path.join(root, "frontend", "tsconfig.json")]);
  const {build} = await import("esbuild");
  // With write:false this path is only used to calculate output names.
  const outdir = path.join(root, ".lodestory-frontend-output");
  const result = await build({
    entryPoints: [realEntry],
    outdir,
    entryNames: "index",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    write: false,
    external: ["react", "react/*", "react-dom", "react-dom/*", "@lodestory/sdk", "@lodestory/sdk/*"],
    loader: {
      ".svg": "file", ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file",
      ".webp": "file", ".woff": "file", ".woff2": "file", ".ttf": "file", ".otf": "file",
    },
    define: {
      __LODESTORY_PLUGIN_ID__: JSON.stringify(config.id),
      __LODESTORY_PLUGIN_NAME__: JSON.stringify(config.name),
    },
  });
  const files = result.outputFiles.map(file => {
    const relative = path.relative(outdir, file.path);
    if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("前端构建产物路径无效。");
    }
    return {path: "dist/frontend/" + relative.split(path.sep).join("/"), bytes: file.contents};
  });
  if (!files.some(file => file.path === "dist/frontend/index.js")) throw new Error("前端入口构建失败。");
  const publicDirectory = path.join(root, "frontend", "assets");
  async function copyAssets(directory, relative = "") {
    let entries;
    try { entries = await fs.readdir(directory, {withFileTypes: true}); }
    catch (error) { if (error.code === "ENOENT" && !relative) return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (!portablePath(name)) throw new Error("前端资源名称不能用于插件包：" + name);
      if (entry.isDirectory()) await copyAssets(file, name);
      else if (entry.isFile()) files.push({path: "dist/frontend/assets/" + name, bytes: await fs.readFile(file)});
      else throw new Error("前端资源必须是普通文件或目录：" + file);
    }
  }
  let assetsStat;
  try { assetsStat = await fs.lstat(publicDirectory); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (assetsStat) {
    if (!assetsStat.isDirectory()) throw new Error("frontend/assets 必须是普通目录。");
    await copyAssets(publicDirectory);
  }
  if (files.some(file => !portablePath(file.path))
      || new Set(files.map(file => file.path.toLowerCase())).size !== files.length) {
    throw new Error("前端构建产物包含无效或重名资源。");
  }
  return files;
}

function nativeTarget() {
  const match = /^host:\s*(\S+)\s*$/m.exec(run("rustc", ["-vV"]));
  if (!match) throw new Error("无法确定 Rust 工具链的目标平台。");
  const target = match[1];
  const arch = target.startsWith("aarch64-") ? "arm64" : target.startsWith("x86_64-") ? "x64" : null;
  const os = target.endsWith("-apple-darwin") ? "macos"
    : target.includes("-linux-") ? "linux" : target.includes("-windows-") ? "windows" : null;
  if (!arch || !os) throw new Error("暂不支持当前 Rust 目标平台：" + target);
  return {target, os, arch};
}

async function backendFile(config, platform) {
  const cargoManifest = path.join(root, "backend", "Cargo.toml");
  const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", cargoManifest]));
  const pkg = metadata.packages.find(item => path.resolve(item.manifest_path) === path.resolve(cargoManifest));
  if (!pkg) throw new Error("无法找到后端 Cargo 项目。");
  const expected = config.backend.type === "process" ? "bin" : "cdylib";
  const targets = pkg.targets.filter(target => target.kind.includes(expected));
  if (targets.length !== 1) throw new Error("后端必须恰好有一个 " + expected + " 构建目标。");
  const output = run("cargo", [
    "build", "--release", "--target", platform.target, "--message-format=json-render-diagnostics",
    "--manifest-path", cargoManifest,
  ]);
  let artifact;
  for (const line of output.split("\n")) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.reason === "compiler-message" && message.message?.rendered) process.stderr.write(message.message.rendered);
    if (message.reason !== "compiler-artifact" || message.package_id !== pkg.id
        || message.target?.name !== targets[0].name || !message.target?.kind?.includes(expected)) continue;
    artifact = expected === "bin" ? message.executable
      : message.filenames?.find(file => /\.(?:dylib|so|dll)$/i.test(file));
  }
  if (!artifact) throw new Error("找不到后端构建产物。");
  const entry = "dist/backend/" + platform.os + "-" + platform.arch + "/" + path.basename(artifact);
  return {path: entry, bytes: await fs.readFile(artifact), executable: expected === "bin"};
}

async function build(config) {
  const files = [];
  if (config.frontend) files.push(...await frontendFiles(config));
  let platform;
  let backend;
  if (config.backend) {
    platform = nativeTarget();
    backend = await backendFile(config, platform);
    files.push(backend);
  }
  return {files, platform, backend};
}

function manifestFor(config, result) {
  const manifest = {
    manifestVersion: "1.0",
    id: config.id,
    name: config.name,
    version: config.version,
    description: config.description ?? "",
    compatibility: config.compatibility,
    dependencies: config.dependencies,
    files: result.files.map(file => ({
      path: file.path,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  if (config.frontend) {
    // The entry stylesheet already includes styles from lazy chunks; listing
    // chunk styles too would cause the host to load the same rules twice.
    const styles = result.files.filter(file => file.path === "dist/frontend/index.css")
      .map(file => file.path);
    manifest.frontend = {entry: "dist/frontend/index.js", ...(styles.length ? {styles} : {})};
  }
  if (config.backend) manifest.backend = {
    type: config.backend.type,
    artifacts: [{...result.platform, entry: result.backend.path}],
  };
  return manifest;
}

async function saveBuild(files) {
  const parent = path.join(root, "build");
  await fs.mkdir(parent, {recursive: true});
  const destination = await fs.mkdtemp(path.join(parent, "run-"));
  try {
    for (const file of files) {
      const output = path.join(destination, ...file.path.split("/"));
      await fs.mkdir(path.dirname(output), {recursive: true});
      await fs.writeFile(output, file.bytes, {flag: "wx", mode: file.executable ? 0o755 : 0o644});
    }
  } catch (error) {
    try { await fs.rm(destination, {recursive: true}); }
    catch (cleanup) { throw new Error("构建失败：" + error.message + "；无法清理 " + destination + "：" + cleanup.message); }
    throw error;
  }
  console.log("构建完成：" + destination);
}

async function savePackage(config, result) {
  const {default: JSZip} = await import("jszip");
  const zip = new JSZip();
  const manifest = JSON.stringify(manifestFor(config, result), null, 2) + "\n";
  const manifestBytes = Buffer.byteLength(manifest);
  if (manifestBytes > 256 * 1024 || manifestBytes + result.files.reduce((total, file) => total + file.bytes.byteLength, 0) > 512 * 1024 * 1024) {
    throw new Error("插件清单或解压后的文件超过宿主大小限制。");
  }
  zip.file("manifest.json", manifest, {unixPermissions: 0o100644});
  for (const file of result.files) {
    zip.file(file.path, file.bytes, {unixPermissions: file.executable ? 0o100755 : 0o100644});
  }
  if (Object.keys(zip.files).length > 4096) throw new Error("插件包中的文件和目录过多。");
  const bytes = await zip.generateAsync({type: "nodebuffer", compression: "DEFLATE", platform: "UNIX"});
  if (bytes.byteLength > 256 * 1024 * 1024) throw new Error("插件包超过 256 MiB 的大小限制。");
  const directory = path.join(root, "release");
  await fs.mkdir(directory, {recursive: true});
  const platformName = result.platform?.target ?? "any";
  const destination = path.join(directory, config.id + "-" + config.version + "-" + platformName + ".zip");
  let handle;
  try {
    handle = await fs.open(destination, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("交付包已存在，未覆盖：" + destination);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    try { await handle.close(); } catch {}
    try { await fs.unlink(destination); }
    catch (cleanup) { throw new Error("打包失败：" + error.message + "；无法清理 " + destination + "：" + cleanup.message); }
    throw error;
  }
  console.log("交付包已生成：" + destination);
}

try {
  if (!["build", "package"].includes(action)) throw new Error("请使用 npm run build 或 npm run package。");
  const config = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  validate(config);
  const result = await build(config);
  if (action === "build") await saveBuild(result.files);
  else await savePackage(config, result);
} catch (error) {
  console.error("构建失败：" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
