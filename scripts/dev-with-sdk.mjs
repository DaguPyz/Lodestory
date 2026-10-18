import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const viteCli = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const services = [
  ["SDK", [require.resolve("typescript/bin/tsc"), "-p", "packages/sdk/tsconfig.json", "--watch", "--preserveWatchOutput"]],
  ["Vite", [viteCli, ...process.argv.slice(2)]],
];
const children = new Set();
let stopping = false;
let forceShutdown;

function stop(code, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  forceShutdown = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 3000);
  forceShutdown.unref();
  for (const child of children) child.kill(signal);
}

// Start the compiler and Vite directly so cleanup also stops the actual watchers.
for (const [name, args] of services) {
  const child = spawn(process.execPath, args, {cwd: projectRoot, stdio: "inherit"});
  children.add(child);
  child.once("error", error => {
    console.error(`${name} failed to start.`, error);
    stop(1);
  });
  child.once("close", (code, signal) => {
    children.delete(child);
    if (!stopping) stop(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    if (!children.size) clearTimeout(forceShutdown);
  });
}

process.once("SIGINT", () => stop(130, "SIGINT"));
process.once("SIGTERM", () => stop(143));
