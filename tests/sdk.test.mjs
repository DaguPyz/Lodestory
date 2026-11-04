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
import * as packageNavigationLayout from "@lodestory/sdk/navigation-layout";
import * as packageWindowShell from "@lodestory/sdk/window-shell";
import * as packageTheme from "@lodestory/sdk/theme";
import * as packageWorkbench from "@lodestory/sdk/workbench";
import * as packageConfig from "@lodestory/sdk/config";
import * as packageDocuments from "@lodestory/sdk/documents";
import * as packageStorage from "@lodestory/sdk/project-storage";
import * as packageSearch from "@lodestory/sdk/project-search";
import * as packageBodyEditor from "@lodestory/sdk/body-editor";
import * as packageCanvas from "@lodestory/sdk/canvas";
import * as packageTimeline from "@lodestory/sdk/timeline";
import * as packageAssetCatalog from "@lodestory/sdk/asset-catalog";
import * as packageContextMenu from "@lodestory/sdk/context-menu";
import * as packageShortcuts from "@lodestory/sdk/shortcuts";
import { createSdkLoader } from "./helpers/sdkFixture.mjs";

const packageManifest = JSON.parse(readFileSync(new URL("../packages/sdk/package.json", import.meta.url), "utf8"));

test("SDK package exposes ESM root and all public capability entry points", () => {
  assert.equal(packageManifest.type, "module");
  assert.deepEqual(Object.keys(packageManifest.exports).sort(), [".", "./asset-catalog", "./body-editor", "./canvas", "./config", "./context-menu", "./documents", "./error", "./layout", "./navigation-layout", "./project-search", "./project-storage", "./shortcuts", "./theme", "./timeline", "./ui", "./window-shell", "./workbench"]);

  assert.equal(packageManifest.exports["./body-editor"].import, "./dist/body-editor.js");
  assert.equal(packageManifest.exports["./body-editor"].types, "./dist/body-editor.d.ts");
  assert.equal(packageManifest.exports["./canvas"].import, "./dist/canvas.js");
  assert.equal(packageManifest.exports["./canvas"].types, "./dist/canvas.d.ts");
  for (const [specifier, target] of [
    [".", "index"],
    ["./error", "error"],
    ["./ui", "ui"],
    ["./layout", "layout"],
    ["./navigation-layout", "navigation-layout"],
    ["./window-shell", "window-shell"],
    ["./theme", "theme"],
    ["./workbench", "workbench"],
    ["./config", "config"],
    ["./context-menu", "context-menu"],
    ["./shortcuts", "shortcuts"],
    ["./documents", "documents"],
    ["./project-storage", "project-storage"],
    ["./project-search", "project-search"],
    ["./canvas", "canvas"],
    ["./timeline", "timeline"],
    ["./asset-catalog", "asset-catalog"],
  ]) {
    assert.equal(packageManifest.exports[specifier].import, `./dist/${target}.js`);
    assert.equal(packageManifest.exports[specifier].types, `./dist/${target}.d.ts`);
  }

  assert.deepEqual(Object.keys(packageRoot).sort(), ["createEventKey", "createServiceKey"]);
  assert.deepEqual(Object.keys(packageUi).sort(), ["UiNavigationCompleteError", "uiInitialPageConfig", "uiInteractionKey", "uiKey", "uiMotionConfig"]);
  assert.equal(typeof packageUi.UiNavigationCompleteError, "function");
  assert.deepEqual(Object.keys(packageError), ["errorUiKey"]);
  assert.deepEqual(Object.keys(packageTheme).sort(), ["themeKey"]);
  assert.deepEqual(Object.keys(packageLayout), ["layoutKey"]);
  assert.deepEqual(Object.keys(packageNavigationLayout), ["navigationLayoutKey"]);
  assert.deepEqual(Object.keys(packageWindowShell), ["windowShellKey"]);
  assert.deepEqual(Object.keys(packageWorkbench), ["workbenchKey"]);
  assert.deepEqual(Object.keys(packageConfig), ["configKey"]);
  assert.deepEqual(Object.keys(packageContextMenu), ["contextMenuKey"]);
  assert.deepEqual(Object.keys(packageShortcuts).sort(), ["shortcutCommandIds", "shortcutScopeIds", "shortcutsKey"]);
  assert.equal(packageShortcuts.shortcutsKey.id, "app/shortcuts");
  assert.equal(packageContextMenu.contextMenuKey.id, "app/context-menu");
  assert.deepEqual(Object.keys(packageDocuments).sort(), ["documentCreateRequested", "documentRevealRequested", "documentsKey", "projectDocumentCatalogKey"]);
  assert.deepEqual(Object.keys(packageStorage), ["projectStorageKey"]);
  assert.deepEqual(Object.keys(packageSearch).sort(), ["projectSearchKey", "projectSearchRequested"]);
  assert.equal(packageStorage.projectStorageKey.id, "app/project-storage");
  assert.deepEqual(Object.keys(packageBodyEditor).sort(), ["bodyEditorContentIds", "bodyEditorDefaultEditorsConfig", "bodyEditorKey"]);
  assert.deepEqual(Object.keys(packageCanvas), ["canvasKey"], "canvas behavior types do not add runtime exports");
  assert.deepEqual(Object.keys(packageTimeline), ["timelineKey"], "timeline behavior types do not add runtime exports");
  assert.deepEqual(Object.keys(packageAssetCatalog), ["assetCatalogKey"], "catalog behavior types do not add runtime exports");
  assert.equal(packageTimeline.timelineKey.id, "app/timeline");
  assert.equal(packageAssetCatalog.assetCatalogKey.id, "app/asset-catalog");
  assert.equal(packageLayout.layoutKey.id, "app/layout");
  assert.equal(packageNavigationLayout.navigationLayoutKey.id, "app/navigation-layout");
  assert.equal(packageWindowShell.windowShellKey.id, "app/window-shell");
  assert.equal(packageUi.uiKey.id, "app/ui");
  assert.equal(packageError.errorUiKey.id, "app/error-ui");
  assert.equal(packageTheme.themeKey.id, "app/theme");
  assert.equal(packageWorkbench.workbenchKey.id, "app/workbench");
  assert.equal(packageConfig.configKey.id, "app/config");
  assert.equal(packageDocuments.documentsKey.id, "app/documents");
  assert.equal(packageBodyEditor.bodyEditorKey.id, "app/body-editor");
  assert.equal(packageBodyEditor.bodyEditorDefaultEditorsConfig.id, "bodyEditor.defaultEditors");
  assert.equal(packageBodyEditor.bodyEditorDefaultEditorsConfig.effect, "restart");
  assert.deepEqual(packageBodyEditor.bodyEditorContentIds, {main: "body-editor.main"});
  assert.equal(packageCanvas.canvasKey.id, "app/canvas");
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
  const hostNavigationLayoutKey = sdk.requireSdk("@lodestory/sdk/navigation-layout").navigationLayoutKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/navigation-layout").navigationLayoutKey, hostNavigationLayoutKey);
  const hostWindowShellKey = sdk.requireSdk("@lodestory/sdk/window-shell").windowShellKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/window-shell").windowShellKey, hostWindowShellKey);
  const hostWorkbenchKey = sdk.requireSdk("@lodestory/sdk/workbench").workbenchKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/workbench").workbenchKey, hostWorkbenchKey);
  const hostConfigKey = sdk.requireSdk("@lodestory/sdk/config").configKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/config").configKey, hostConfigKey);
  const hostShortcutsKey = sdk.requireSdk("@lodestory/sdk/shortcuts").shortcutsKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/shortcuts").shortcutsKey, hostShortcutsKey);
  const hostContextMenuKey = sdk.requireSdk("@lodestory/sdk/context-menu").contextMenuKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/context-menu").contextMenuKey, hostContextMenuKey);
  const hostDocumentsKey = sdk.requireSdk("@lodestory/sdk/documents").documentsKey;
  const hostStorageKey = sdk.requireSdk("@lodestory/sdk/project-storage").projectStorageKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/project-storage").projectStorageKey, hostStorageKey);
  const searchContract = sdk.requireSdk("@lodestory/sdk/project-search");
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/project-search").projectSearchKey, searchContract.projectSearchKey);
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/project-search").projectSearchRequested, searchContract.projectSearchRequested);
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentsKey, hostDocumentsKey);
  const hostBodyEditorKey = sdk.requireSdk("@lodestory/sdk/body-editor").bodyEditorKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/body-editor").bodyEditorKey, hostBodyEditorKey);
  assert.equal(hostBodyEditorKey.id, "app/body-editor");
  const hostCanvasKey = sdk.requireSdk("@lodestory/sdk/canvas").canvasKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/canvas").canvasKey, hostCanvasKey);
  assert.equal(hostCanvasKey.id, "app/canvas");
  const hostAssetCatalogKey = sdk.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey, hostAssetCatalogKey);
  assert.equal(hostAssetCatalogKey.id, "app/asset-catalog");
  const hostDocumentCreateRequested = sdk.requireSdk("@lodestory/sdk/documents").documentCreateRequested;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentCreateRequested, hostDocumentCreateRequested);
  const hostDocumentRevealRequested = sdk.requireSdk("@lodestory/sdk/documents").documentRevealRequested;
  assert.strictEqual(sdk.requireSdk("@lodestory/sdk/documents").documentRevealRequested, hostDocumentRevealRequested);
  assert.strictEqual(pluginUiKey, hostUiKey);
  assert.strictEqual(pluginThemeKey, hostThemeKey);
  assert.equal(sdk.evaluatedModules.filter((path) => path === "ServiceKey.ts").length, 1);
  assert.equal(hostWorkbenchKey.id, "app/workbench");
  assert.equal(hostNavigationLayoutKey.id, "app/navigation-layout");
  assert.equal(hostWindowShellKey.id, "app/window-shell");
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
