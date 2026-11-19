import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targetDir = path.join(root, "src-tauri", "target");
const env = { ...process.env, CARGO_TARGET_DIR: targetDir, CI: "true" };
const usage = "Usage: pnpm build:installers [all|macos|windows]";

function run(command, args, { env: commandEnv = env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} was interrupted by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
  return result.stdout?.trim();
}

function hasCommand(command, commandEnv) {
  return spawnSync("/usr/bin/which", ["-s", command], { env: commandEnv }).status === 0;
}

function buildMacos(product, version) {
  const targets = { aarch64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };
  const macEnv = { ...env };
  if (!macEnv.APPLE_SIGNING_IDENTITY && !macEnv.APPLE_CERTIFICATE) {
    const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
    const developerIds = [...identities.matchAll(/"(Developer ID Application: [^"\r\n]+)"\s*$/gm)];
    if (developerIds.length === 0) {
      throw new Error("Import a Developer ID Application certificate and its private key into your macOS keychain.");
    }
    if (developerIds.length > 1) {
      throw new Error("Several Developer ID Application identities are available. Set APPLE_SIGNING_IDENTITY to select one.");
    }
    macEnv.APPLE_SIGNING_IDENTITY = developerIds[0][1];
  }

  const adHoc = macEnv.APPLE_SIGNING_IDENTITY === "-";
  if (adHoc) {
    delete macEnv.APPLE_CERTIFICATE;
    delete macEnv.APPLE_CERTIFICATE_PASSWORD;
  } else if (macEnv.APPLE_CERTIFICATE && macEnv.APPLE_CERTIFICATE_PASSWORD === undefined) {
    throw new Error("Set APPLE_CERTIFICATE_PASSWORD when using APPLE_CERTIFICATE.");
  }
  if (adHoc || macEnv.LODESTORY_MACOS_NOTARIZE !== "1") {
    for (const key of ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
      delete macEnv[key];
    }
  }

  run("rustup", ["target", "add", ...Object.values(targets)]);
  return Object.entries(targets).map(([arch, target]) => {
    run("pnpm", ["build:desktop", "--target", target, "--bundles", "dmg", "--", "--locked"], { env: macEnv });
    return path.join(targetDir, target, "release", "bundle", "dmg", `${product}_${version}_${arch}.dmg`);
  });
}

function buildWindows(product, version) {
  const target = "x86_64-pc-windows-msvc";
  const windowsEnv = {
    ...env,
    XWIN_CACHE_DIR: path.resolve(root, env.XWIN_CACHE_DIR || path.join(targetDir, "xwin")),
    XWIN_CROSS_COMPILER: env.XWIN_CROSS_COMPILER || "clang",
  };
  const requireCommand = (command, hint) => {
    if (!hasCommand(command, windowsEnv)) throw new Error(`Missing ${command}. ${hint}`);
  };

  requireCommand("cargo-xwin", "Run cargo install --locked cargo-xwin.");
  requireCommand("makensis", "Run brew install nsis.");
  if (hasCommand("brew", windowsEnv)) {
    const prefix = run("brew", ["--prefix"], { capture: true });
    windowsEnv.PATH += `:${path.join(prefix, "opt", "llvm", "bin")}:${path.join(prefix, "opt", "lld", "bin")}`;
  }
  requireCommand("llvm-rc", "Install LLVM and add its bin directory to PATH.");
  if (!hasCommand("lld-link", windowsEnv)) {
    // cargo-xwin invokes the generic LLD driver with -flavor link.
    const libDir = run("rustc", ["--print", "target-libdir"], { capture: true });
    const lld = path.join(libDir, "..", "bin", "rust-lld");
    if (hasCommand(lld, windowsEnv)) {
      mkdirSync(windowsEnv.XWIN_CACHE_DIR, { recursive: true });
      const link = path.join(windowsEnv.XWIN_CACHE_DIR, "lld-link");
      try {
        symlinkSync(lld, link);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      windowsEnv.PATH += `:${windowsEnv.XWIN_CACHE_DIR}`;
    }
  }
  requireCommand("lld-link", "Run brew install lld and add its bin directory to PATH.");

  const args = ["build:desktop", "--runner", "cargo-xwin", "--target", target, "--bundles", "nsis"];
  if (windowsEnv.LODESTORY_WINDOWS_SIGN !== "1") args.push("--no-sign");
  run("rustup", ["target", "add", target]);
  run("pnpm", [...args, "--", "--locked"], { env: windowsEnv });
  return [path.join(targetDir, target, "release", "bundle", "nsis", `${product}_${version}_x64-setup.exe`)];
}

function main() {
  const builds = { macos: buildMacos, windows: buildWindows };
  const [platform = "all", ...extra] = process.argv.slice(2);
  if (extra.length === 0 && ["-h", "--help"].includes(platform)) {
    console.log(usage);
    return;
  }
  if (extra.length > 0 || (platform !== "all" && !Object.hasOwn(builds, platform))) {
    throw new Error(usage);
  }
  if (process.platform !== "darwin") {
    throw new Error("Use a Mac to build macOS or cross-compile Windows with this script.");
  }

  const { productName, version } = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ].map((part) => String(part).padStart(2, "0")).join("");
  const outputBase = path.join(root, "output");
  mkdirSync(outputBase, { recursive: true });
  const output = path.join(outputBase, `installers.${timestamp}`);
  mkdirSync(output);
  const failed = [];
  const platforms = platform === "all" ? Object.keys(builds) : [platform];
  for (const name of platforms) {
    try {
      console.log(`Building ${name} installers`);
      const installers = builds[name](productName, version);
      for (const installer of installers) {
        if (!statSync(installer, { throwIfNoEntry: false })?.size) {
          throw new Error(`Installer missing or empty: ${installer}`);
        }
      }
      const destination = path.join(output, name);
      mkdirSync(destination);
      for (const installer of installers) {
        copyFileSync(installer, path.join(destination, path.basename(installer)));
      }
      console.log(`Installers: ${destination}`);
    } catch (error) {
      console.error(`${name}: ${error.message}`);
      failed.push(name);
    }
  }
  if (failed.length) {
    try {
      rmdirSync(output);
    } catch (error) {
      if (error.code !== "ENOTEMPTY") throw error;
    }
    throw new Error(`Build failed for: ${failed.join(", ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
