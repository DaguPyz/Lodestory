import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {createServer} from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const harnessSource = fileURLToPath(new URL("./fixtures/asset-card-masonry-webkit.swift", import.meta.url));

function runHarness(executable, url, timeoutMs = 30000) {
  const child = spawn(executable, [url], {stdio: ["ignore", "pipe", "pipe"]});
  const output = {stdout: "", stderr: ""};
  child.stdout.setEncoding("utf8").on("data", chunk => { output.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { output.stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`WKWebView harness timed out after ${timeoutMs}ms.\n${output.stderr}`));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`WKWebView harness exited with code ${code}.\n${output.stderr}\n${output.stdout}`));
        return;
      }
      resolve(output);
    });
  });
  return {child, result};
}

function readMetrics(output) {
  const line = output.stdout.split(/\r?\n/).find(value => value.startsWith("LODESTORY_WK_METRICS:"));
  assert.ok(line, `WKWebView harness did not return metrics.\n${output.stderr}\n${output.stdout}`);
  const result = JSON.parse(line.slice("LODESTORY_WK_METRICS:".length));
  assert.equal(result.error, undefined, result.error);
  return result;
}

function assertBounds(layout, expectedColumns, label) {
  assert.equal(layout.cards.length, 4, `${label}: fixture keeps four cards`);
  assert.equal(layout.grid.tracks.length, expectedColumns, `${label}: expected ${expectedColumns} grid columns`);
  assert.ok(Math.abs(layout.editor.paddingLeft - 40) <= 1, `${label}: editor keeps 40px left padding`);
  assert.ok(Math.abs(layout.editor.paddingRight - 40) <= 1, `${label}: editor keeps 40px right padding`);
  assert.ok(layout.list.left >= layout.editor.left + layout.editor.paddingLeft - 1,
    `${label}: list starts inside the editor's left padding`);
  assert.ok(layout.list.right <= layout.editor.right - layout.editor.paddingRight + 1,
    `${label}: list ends before the editor's right padding`);
  for (const card of layout.cards) {
    assert.ok(card.left >= layout.list.left - 1, `${label}: ${card.id} stays inside the list's left edge`);
    assert.ok(card.right <= layout.list.right + 1, `${label}: ${card.id} stays inside the list's right edge`);
    assert.ok(layout.editor.right - card.right >= layout.editor.paddingRight - 1,
      `${label}: ${card.id} preserves the editor's right padding`);
  }
  assert.ok(layout.editor.scrollWidth <= layout.editor.clientWidth + 1,
    `${label}: cards do not cause horizontal overflow in the editor`);
}

test("asset card masonry respects WebKit grid bounds and keeps all three columns populated", {timeout: 120000}, async t => {
  if (process.platform !== "darwin") {
    t.skip("WKWebView regression runs only on macOS.");
    return;
  }

  const swiftVersion = spawnSync("swiftc", ["--version"], {encoding: "utf8", timeout: 5000});
  if (swiftVersion.error?.code === "ENOENT" || swiftVersion.status === null) {
    t.skip("Swift compiler is unavailable; WKWebView regression was not run.");
    return;
  }
  if (swiftVersion.status !== 0) {
    t.skip(`Swift compiler is unavailable: ${swiftVersion.stderr || swiftVersion.error?.message || "swiftc --version failed"}`);
    return;
  }

  const temp = await mkdtemp(path.join(tmpdir(), "lodestory-wkwebview-masonry-"));
  const executable = path.join(temp, "asset-card-masonry-webkit");
  const moduleCache = path.join(temp, "swift-module-cache");
  let server;
  let harness;
  try {
    await mkdir(moduleCache);
    const compile = spawnSync("swiftc", ["-module-cache-path", moduleCache, "-framework", "AppKit", "-framework", "WebKit",
      harnessSource, "-o", executable], {
      cwd: root,
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(compile.status, 0,
      `Could not compile WKWebView regression harness.\n${compile.stderr || compile.error?.message || "No compiler diagnostics."}`);

    server = await createServer({
      configFile: false,
      root,
      appType: "mpa",
      server: {host: "127.0.0.1", port: 0, strictPort: true, hmr: false},
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    harness = runHarness(executable, `http://127.0.0.1:${address.port}/tests/fixtures/asset-card-masonry.html`);
    const output = await harness.result;
    const metrics = readMetrics(output);

    assertBounds(metrics.initial, 3, "three-column layout");
    const firstRow = metrics.initial.cards.slice(0, 3);
    assert.equal(new Set(firstRow.map(card => Math.round(card.top))).size, 1,
      "the first three cards occupy the first row");
    assert.equal(new Set(firstRow.map(card => Math.round(card.left))).size, 3,
      "the first row occupies three distinct columns");
    assert.ok(metrics.initial.cards[3].top > firstRow[0].top,
      "the fourth card starts below the populated first row");

    assertBounds(metrics.twoColumn, 2, "two-column resize");
    assert.equal(new Set(metrics.twoColumn.cards.slice(0, 2).map(card => Math.round(card.top))).size, 1,
      "the first two cards occupy the first row after resizing");
    assert.equal(new Set(metrics.twoColumn.cards.map(card => Math.round(card.left))).size, 2,
      "the resized layout occupies two distinct columns");
  } finally {
    if (harness?.child.exitCode === null) {
      harness.child.kill("SIGTERM");
      await new Promise(resolve => harness.child.once("close", resolve));
    }
    await server?.close();
    await rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
