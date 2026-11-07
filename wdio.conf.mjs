import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const binary = process.platform === "win32" ? "lodestory.exe" : "lodestory";
const appBinaryPath = path.join(root, ".desktop-e2e", "target", "debug", binary);

export const config = {
  runner: "local",
  specs: [path.join(root, "tests", "desktop", "**", "*.spec.mjs")],
  maxInstances: 1,
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 60000 },
  services: [["@wdio/tauri-service", { appBinaryPath, driverProvider: "embedded" }]],
  capabilities: [{ browserName: "tauri", "tauri:options": { application: appBinaryPath } }],
};
