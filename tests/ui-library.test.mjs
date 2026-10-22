import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import ts from "typescript";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import * as ui from "@lodestory/ui";

const {Button, Dialog, DialogActions, DialogClose, Icon, IconButton, SearchField, Select} = ui;

test("the UI package exposes its components, React peer, declaration build, and separate stylesheet", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/ui/package.json", import.meta.url), "utf8"));
  const declarations = await readFile(new URL("../packages/ui/dist/index.d.ts", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL(import.meta.resolve("@lodestory/ui/styles.css")), "utf8");

  assert.equal(manifest.name, "@lodestory/ui");
  assert.equal(manifest.peerDependencies.react, "^19.1.0");
  assert.equal(manifest.peerDependencies["react-dom"], "^19.1.0");
  assert.ok(manifest.dependencies["@base-ui/react"], "Base UI is declared by the package that wraps it");
  assert.equal(manifest.exports["./styles.css"], "./styles.css");
  assert.deepEqual(Object.keys(ui).sort(), ["Button", "Dialog", "DialogActions", "DialogClose", "Icon", "IconButton", "SearchField", "Select"]);
  assert.match(declarations, /ButtonProps/);
  assert.match(declarations, /DialogProps/);
  assert.match(declarations, /DialogActionsProps/);
  assert.match(declarations, /DialogCloseProps/);
  assert.match(declarations, /IconName/);
  assert.match(declarations, /IconSize/);
  assert.match(declarations, /SearchFieldProps/);
  assert.match(declarations, /SelectProps/);
  assert.match(declarations, /SelectOption/);
  assert.match(stylesheet, /\.button--primary/);
  assert.match(stylesheet, /\.ui-dialog-backdrop/);
  assert.match(stylesheet, /\.ui-dialog\s*\{/);
  assert.match(stylesheet, /\.ui-dialog-title/);
  assert.match(stylesheet, /\.ui-dialog-description/);
  assert.match(stylesheet, /\.ui-dialog-actions/);
  assert.match(stylesheet, /\.icon-button/);
  assert.match(stylesheet, /\.search-field/);
  assert.match(stylesheet, /\.ui-select\s*\{/);
  assert.match(stylesheet, /\.ui-select-trigger/);
  assert.match(stylesheet, /\.ui-select-option/);
  assert.match(stylesheet, /var\(--ui-/);
});

test("public UI components render on the server without browser globals", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(Button, {variant: "primary"}, "保存"),
    createElement(IconButton, {label: "关闭"}, createElement(Icon, {name: "close"})),
    createElement(SearchField, {label: "搜索项目", value: "项目", readOnly: true}),
    createElement(Select, {value: "", "aria-label": "选择目录", options: [{value: "", label: "项目根目录"}, {value: "chapter", label: "项目/chapter"}]}),
  ));
  const closedDialog = renderToStaticMarkup(createElement(Dialog, {
    open: false,
    onOpenChange() {},
    title: "服务器弹框",
    description: "关闭状态可安全进行服务端渲染。",
  }, createElement("p", null, "弹框内容")));
  const dialogActions = renderToStaticMarkup(createElement(DialogActions, {"data-testid": "dialog-actions"},
    createElement("span", null, "操作区")));
  const closeElement = createElement(DialogClose, {variant: "secondary"}, "关闭");

  assert.match(html, /class="button button--primary"[^>]*>保存<\/button>/);
  assert.match(html, /class="icon-button"[^>]*aria-label="关闭"/);
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="搜索项目"/);
  assert.match(html, /value="项目"/);
  assert.match(html, /class="ui-select-trigger"/);
  assert.match(html, /选择目录/);
  assert.match(html, /项目根目录/);
  assert.equal(closedDialog, "", "a closed dialog is safe to render without browser globals");
  assert.match(dialogActions, /<div[^>]*class="ui-dialog-actions"[^>]*>/);
  assert.match(dialogActions, /data-testid="dialog-actions"/);
  assert.equal(closeElement.type, DialogClose, "DialogClose is available as a public React component");
  assert.equal(closeElement.props.variant, "secondary");
});

test("Dialog keeps controlled state and cancels close requests while busy", () => {
  const changes = [];
  let cancellations = 0;
  const tree = Dialog({
    open: true,
    onOpenChange(open) { changes.push(open); },
    title: "处理中",
    busy: true,
    children: createElement(DialogClose, null, "关闭"),
  });
  const root = tree.props.children;

  assert.equal(root.props.open, true, "Dialog reflects its controlled open prop");
  assert.equal(root.props.disablePointerDismissal, true, "busy prevents pointer dismissal");
  root.props.onOpenChange(false, {cancel() { cancellations += 1; }});
  assert.deepEqual(changes, [], "busy close requests do not change controlled state");
  assert.equal(cancellations, 1, "busy close requests cancel the underlying Base UI event");
  root.props.onOpenChange(true, {cancel() { cancellations += 1; }});
  assert.deepEqual(changes, [true], "open state changes still reach the owning component");
  assert.equal(cancellations, 1, "non-close transitions are not cancelled");
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
    ...registry.shadowRecipes.map(recipe => recipe.cssVariable),
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
