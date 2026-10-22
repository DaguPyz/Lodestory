import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as packageRoot from "@lodestory/sdk";
import * as packageUi from "@lodestory/sdk/ui";
import * as packageError from "@lodestory/sdk/error";
import * as packageLayout from "@lodestory/sdk/layout";
import * as packageTheme from "@lodestory/sdk/theme";
import * as packageWorkbench from "@lodestory/sdk/workbench";
import * as packageConfig from "@lodestory/sdk/config";
import * as packageDocuments from "@lodestory/sdk/documents";
import * as packageBodyEditor from "@lodestory/sdk/body-editor";
import { createSdkLoader } from "./helpers/sdkFixture.mjs";

const packageManifest = JSON.parse(readFileSync(new URL("../packages/sdk/package.json", import.meta.url), "utf8"));

test("SDK package exposes ESM root and all public capability entry points", () => {
  assert.equal(packageManifest.type, "module");
  assert.deepEqual(Object.keys(packageManifest.exports).sort(), [".", "./body-editor", "./config", "./documents", "./error", "./layout", "./theme", "./ui", "./workbench"]);

  assert.equal(packageManifest.exports["./body-editor"].import, "./dist/body-editor.js");
  assert.equal(packageManifest.exports["./body-editor"].types, "./dist/body-editor.d.ts");
  for (const [specifier, target] of [
    [".", "index"],
    ["./error", "error"],
    ["./ui", "ui"],
    ["./layout", "layout"],
    ["./theme", "theme"],
    ["./workbench", "workbench"],
    ["./config", "config"],
    ["./documents", "documents"],
  ]) {
    assert.equal(packageManifest.exports[specifier].import, `./dist/${target}.js`);
    assert.equal(packageManifest.exports[specifier].types, `./dist/${target}.d.ts`);
  }

  assert.deepEqual(Object.keys(packageRoot).sort(), ["createEventKey", "createServiceKey"]);
  assert.deepEqual(Object.keys(packageUi).sort(), ["UiNavigationCompleteError", "uiInitialPageConfig", "uiKey", "uiMotionConfig"]);
  assert.equal(typeof packageUi.UiNavigationCompleteError, "function");
  assert.deepEqual(Object.keys(packageError), ["errorUiKey"]);
  assert.deepEqual(Object.keys(packageTheme).sort(), ["themeKey"]);
  assert.deepEqual(Object.keys(packageLayout), ["layoutKey"]);
  assert.deepEqual(Object.keys(packageWorkbench), ["workbenchKey"]);
  assert.deepEqual(Object.keys(packageConfig), ["configKey"]);
  assert.deepEqual(Object.keys(packageDocuments).sort(), ["documentCreateRequested", "documentRevealRequested", "documentsKey"]);
  assert.deepEqual(Object.keys(packageBodyEditor).sort(), ["bodyEditorDefaultEditorsConfig", "bodyEditorKey"]);
  assert.equal(packageLayout.layoutKey.id, "app/layout");
  assert.equal(packageUi.uiKey.id, "app/ui");
  assert.equal(packageError.errorUiKey.id, "app/error-ui");
  assert.equal(packageTheme.themeKey.id, "app/theme");
  assert.equal(packageWorkbench.workbenchKey.id, "app/workbench");
  assert.equal(packageConfig.configKey.id, "app/config");
  assert.equal(packageDocuments.documentsKey.id, "app/documents");
  assert.equal(packageBodyEditor.bodyEditorKey.id, "app/body-editor");
  assert.equal(packageBodyEditor.bodyEditorDefaultEditorsConfig.id, "bodyEditor.defaultEditors");
  assert.equal(packageBodyEditor.bodyEditorDefaultEditorsConfig.effect, "restart");
  const validateBodyEditorDefaults = packageBodyEditor.bodyEditorDefaultEditorsConfig.validate;
  assert.equal(validateBodyEditorDefaults({markdown: "milkdown", "plain-text": "textarea"}), true);
  assert.equal(validateBodyEditorDefaults({}), true, "unconfigured formats may remain unavailable");
  assert.equal(validateBodyEditorDefaults(Object.create(null)), true, "JSON object records may have a null prototype");
  assert.equal(validateBodyEditorDefaults(runInNewContext("({markdown: 'quill'})")), true,
    "plain records from another realm remain valid configuration values");
  assert.equal(validateBodyEditorDefaults(runInNewContext("Object.assign(Object.create(null), {markdown: 'quill'})")), true,
    "null-prototype records from another realm remain valid");
  assert.equal(validateBodyEditorDefaults(runInNewContext("new (class CustomConfig {})()")), false,
    "custom class instances are not plain configuration records");
  assert.equal(validateBodyEditorDefaults(runInNewContext("new Date()")), false,
    "built-in instances are not plain configuration records");
  assert.equal(validateBodyEditorDefaults(null), false);
  assert.equal(validateBodyEditorDefaults([]), false);
  assert.equal(validateBodyEditorDefaults(Object.create({markdown: "milkdown"})), false);
  assert.equal(validateBodyEditorDefaults({tabs: "editor"}), false);
  assert.equal(validateBodyEditorDefaults({markdown: "  "}), false);
  assert.equal(packageDocuments.documentCreateRequested.id, "app/documents/create-requested");
  assert.equal(packageDocuments.documentRevealRequested.id, "app/documents/reveal-requested");
  assert.equal(packageUi.uiInitialPageConfig.id, "ui.initialPage");
  assert.equal(packageUi.uiMotionConfig.id, "ui.motion");
  assert.equal(packageUi.uiMotionConfig.defaultValue, "system");
  assert.equal(packageUi.uiMotionConfig.effect, "live");
  assert.equal(packageUi.uiMotionConfig.validate("system"), true);
  assert.equal(packageUi.uiMotionConfig.validate("reduce"), true);
  assert.equal(packageUi.uiMotionConfig.validate("full"), false);
  assert.equal(packageUi.uiMotionConfig.validate(null), false);
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
  const hostWorkbenchKey = sdk.requireSdk("@lodestory/sdk/workbench").workbenchKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/workbench").workbenchKey, hostWorkbenchKey);
  const hostConfigKey = sdk.requireSdk("@lodestory/sdk/config").configKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/config").configKey, hostConfigKey);
  const hostDocumentsKey = sdk.requireSdk("@lodestory/sdk/documents").documentsKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentsKey, hostDocumentsKey);
  const hostBodyEditorKey = sdk.requireSdk("@lodestory/sdk/body-editor").bodyEditorKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/body-editor").bodyEditorKey, hostBodyEditorKey);
  assert.equal(hostBodyEditorKey.id, "app/body-editor");
  const hostDocumentCreateRequested = sdk.requireSdk("@lodestory/sdk/documents").documentCreateRequested;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentCreateRequested, hostDocumentCreateRequested);
  const hostDocumentRevealRequested = sdk.requireSdk("@lodestory/sdk/documents").documentRevealRequested;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentRevealRequested, hostDocumentRevealRequested);
  assert.strictEqual(pluginUiKey, hostUiKey);
  assert.strictEqual(pluginThemeKey, hostThemeKey);
  assert.equal(sdk.evaluatedModules.filter((path) => path === "ServiceKey.ts").length, 1);
  assert.equal(hostWorkbenchKey.id, "app/workbench");
  assert.equal(hostConfigKey.id, "app/config");
  assert.equal(hostDocumentsKey.id, "app/documents");
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
