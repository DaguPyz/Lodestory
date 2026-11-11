import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const pnpmEntry = process.env.npm_execpath;
const pnpm = pnpmEntry ? process.execPath : (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
const packageData = mkdtempSync(path.join(tmpdir(), "lodestory-desktop-packages-"));
const env = {
  ...process.env,
  LODESTORY_DESKTOP_E2E: "1",
  CARGO_TARGET_DIR: fileURLToPath(new URL("../.desktop-e2e/target", import.meta.url)),
  LODESTORY_DESKTOP_E2E_DATA: packageData,
};

function run(args) {
  const result = spawnSync(pnpm, pnpmEntry ? [pnpmEntry, ...args] : args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Desktop test command failed with exit code ${result.status ?? 1}.`);
}

try {
  run(["exec", "tauri", "build", "--debug", "--no-bundle", "--features", "desktop-e2e", "--config", "src-tauri/tauri.e2e.conf.json"]);
  // The embedded driver otherwise defaults to a shared fixed port and can connect
  // to a different running Tauri test application instead of the one just built.
  env.TAURI_WEBDRIVER_PORT = String(await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not allocate a desktop test port.")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  }));
  run(["exec", "wdio", "run", "wdio.conf.mjs", ...process.argv.slice(2)]);
} finally {
  rmSync(packageData, {recursive: true, force: true});
}
