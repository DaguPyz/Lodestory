import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import ts from "typescript";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import * as ui from "@lodestory/ui";

const {Button, Icon, IconButton, SearchField} = ui;

test("the UI package exposes its components, React peer, declaration build, and separate stylesheet", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/ui/package.json", import.meta.url), "utf8"));
  const declarations = await readFile(new URL("../packages/ui/dist/index.d.ts", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL(import.meta.resolve("@lodestory/ui/styles.css")), "utf8");

  assert.equal(manifest.name, "@lodestory/ui");
  assert.equal(manifest.peerDependencies.react, "^19.1.0");
  assert.equal(manifest.exports["./styles.css"], "./styles.css");
  assert.deepEqual(Object.keys(ui).sort(), ["Button", "Icon", "IconButton", "SearchField"]);
  assert.match(declarations, /ButtonProps/);
  assert.match(declarations, /IconName/);
  assert.match(declarations, /IconSize/);
  assert.match(declarations, /SearchFieldProps/);
  assert.match(stylesheet, /\.button--primary/);
  assert.match(stylesheet, /\.icon-button/);
  assert.match(stylesheet, /\.search-field/);
  assert.match(stylesheet, /var\(--ui-/);
});

test("public UI components render on the server without browser globals", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(Button, {variant: "primary"}, "保存"),
    createElement(IconButton, {label: "关闭"}, createElement(Icon, {name: "close"})),
    createElement(SearchField, {label: "搜索项目", value: "项目", readOnly: true}),
  ));

  assert.match(html, /class="button button--primary"[^>]*>保存<\/button>/);
  assert.match(html, /class="icon-button"[^>]*aria-label="关闭"/);
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="搜索项目"/);
  assert.match(html, /value="项目"/);
});

test("public TypeScript declarations accept the supported component props and reject invalid variants", () => {
  const fixture = fileURLToPath(new URL("./fixtures/ui-library-types.tsx", import.meta.url));
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(({messageText}) => ts.flattenDiagnosticMessageText(messageText, "\n")), []);
});

test("state and focus props stay semantic and do not leak unknown React attributes", () => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(Button, {variant: "danger", "aria-pressed": true, disabled: true, selectionActive: false}, "删除"),
    createElement(IconButton, {label: "反色邻面", focusSurface: "inverse", "aria-pressed": "mixed"}),
    createElement(SearchField, {label: "校验", focusSurface: "inverse", "aria-invalid": true, readOnly: true}),
  ));
  assert.match(html, /aria-pressed="true"[^>]*disabled=""[^>]*class="button button--danger"[^>]*data-selection-active="false"/);
  assert.match(html, /class="icon-button"[^>]*data-focus-surface="inverse"/);
  assert.match(html, /<label class="search-field" data-focus-surface="inverse">/);
  assert.match(html, /<input aria-invalid="true" readOnly=""/);
  assert.doesNotMatch(html, /selectionActive|focusSurface/);
});

test("UI styles use registered host tokens without embedding a second palette", async () => {
  const stylesheet = await readFile(new URL(import.meta.resolve("@lodestory/ui/styles.css")), "utf8");
  const registry = JSON.parse(await readFile(new URL("../src/plugins/theme/color-registry.json", import.meta.url), "utf8"));
  const geometry = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const known = new Set([
    ...registry.colors.map(color => color.cssVariable),
    ...[...geometry.matchAll(/(--ui-[\w-]+)\s*:/g)].map(match => match[1]),
  ]);
  const consumed = [...stylesheet.matchAll(/var\((--ui-[\w-]+)\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(consumed)].filter(variable => !known.has(variable)), []);
  assert.doesNotMatch(stylesheet, /#[\da-f]{3,8}\b|(?:rgb|hsl|oklch)\s*\(|data-ui-theme\s*=/i);
  // The four roles deliberately differ from their legacy default aliases in custom themes.
  for (const role of ["action.foreground", "state.disabledForeground", "selection.foreground", "caret.foreground"]) {
    assert.ok(consumed.includes(registry.colors.find(color => color.id === role).cssVariable), role);
  }
});
