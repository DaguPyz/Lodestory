import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as packageRoot from "@lodestory/sdk";
import * as packageUi from "@lodestory/sdk/ui";
import * as packageError from "@lodestory/sdk/error";
import * as packageLayout from "@lodestory/sdk/layout";
import * as packageTheme from "@lodestory/sdk/theme";
import { createSdkLoader } from "./helpers/sdkFixture.mjs";

const packageManifest = JSON.parse(readFileSync(new URL("../packages/sdk/package.json", import.meta.url), "utf8"));

test("SDK package exposes ESM root, UI, error, theme, and layout entry points", () => {
  assert.equal(packageManifest.type, "module");
  assert.deepEqual(Object.keys(packageManifest.exports).sort(), [".", "./error", "./layout", "./theme", "./ui"]);

  for (const [specifier, target] of [
    [".", "index"],
    ["./error", "error"],
    ["./ui", "ui"],
    ["./layout", "layout"],
    ["./theme", "theme"],
  ]) {
    assert.equal(packageManifest.exports[specifier].import, `./dist/${target}.js`);
    assert.equal(packageManifest.exports[specifier].types, `./dist/${target}.d.ts`);
  }

  assert.deepEqual(Object.keys(packageRoot).sort(), ["createEventKey", "createServiceKey"]);
  assert.deepEqual(Object.keys(packageUi), ["uiKey"]);
  assert.deepEqual(Object.keys(packageError), ["errorUiKey"]);
  assert.deepEqual(Object.keys(packageTheme).sort(), ["themeKey"]);
  assert.deepEqual(Object.keys(packageLayout), ["layoutKey"]);
  assert.equal(packageLayout.layoutKey.id, "app/layout");
  assert.equal(packageUi.uiKey.id, "app/ui");
  assert.equal(packageError.errorUiKey.id, "app/error-ui");
  assert.equal(packageTheme.themeKey.id, "app/theme");
  assert.ok(packageManifest.files.includes("dist"), "the packed package must include the runtime and declaration outputs");
});

test("SDK subpaths share one key module and need no host imports or runtime APIs", () => {
  const hostAccesses = [];
  const hostApi = new Proxy({}, {
    get(_target, property) {
      hostAccesses.push(String(property));
      throw new Error(`SDK accessed host API property '${String(property)}' during module evaluation.`);
    },
    set(_target, property) {
      hostAccesses.push(String(property));
      throw new Error(`SDK wrote host API property '${String(property)}' during module evaluation.`);
    },
  });
  const modules = new Map();
  const sdk = createSdkLoader({
    modules,
    globals: {
      window: hostApi,
      document: hostApi,
      localStorage: hostApi,
      __TAURI__: hostApi,
    },
  });

  const hostUiKey = sdk.requireSdk("@lodestory/sdk/ui").uiKey;
  const pluginUiKey = sdk.requireSdk("@lodestory/sdk/ui").uiKey;
  const hostThemeKey = sdk.requireSdk("@lodestory/sdk/theme").themeKey;
  const pluginThemeKey = sdk.requireSdk("@lodestory/sdk/theme").themeKey;

  const hostLayoutKey = sdk.requireSdk("@lodestory/sdk/layout").layoutKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/layout").layoutKey, hostLayoutKey);
  assert.strictEqual(pluginUiKey, hostUiKey);
  assert.strictEqual(pluginThemeKey, hostThemeKey);
  assert.equal(sdk.evaluatedModules.filter((path) => path === "ServiceKey.ts").length, 1);
  assert.deepEqual(hostAccesses, []);
  assert.equal(sdk.imports.filter(({ from }) => from !== "fixture").every(({ specifier }) => specifier.startsWith(".")), true);
});

test("public SDK types preserve service and generic event contracts", () => {
  const fixture = fileURLToPath(new URL("./fixtures/sdk-types.ts", import.meta.url));
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")), []);
});
