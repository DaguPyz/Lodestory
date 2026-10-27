import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import ts from "typescript";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import * as ui from "@lodestory/ui";

const {Button, Dialog, DialogActions, DialogClose, Icon, IconButton, SearchField, Select, TextField, Textarea} = ui;

test("the UI package exposes its components, React peer, declaration build, and separate stylesheet", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/ui/package.json", import.meta.url), "utf8"));
  const declarations = await readFile(new URL("../packages/ui/dist/index.d.ts", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL(import.meta.resolve("@lodestory/ui/styles.css")), "utf8");

  assert.equal(manifest.name, "@lodestory/ui");
  assert.equal(manifest.peerDependencies.react, "^19.1.0");
  assert.equal(manifest.peerDependencies["react-dom"], "^19.1.0");
  assert.ok(manifest.dependencies["@base-ui/react"], "Base UI is declared by the package that wraps it");
  assert.equal(manifest.exports["./styles.css"], "./styles.css");
  assert.deepEqual(Object.keys(ui).sort(), ["Button", "Dialog", "DialogActions", "DialogClose", "Icon", "IconButton", "SearchField", "Select", "TextField", "Textarea"]);
  assert.match(declarations, /ButtonProps/);
  assert.match(declarations, /DialogProps/);
  assert.match(declarations, /DialogActionsProps/);
  assert.match(declarations, /DialogCloseProps/);
  assert.match(declarations, /IconName/);
  assert.match(declarations, /IconSize/);
  assert.match(declarations, /SearchFieldProps/);
  assert.match(declarations, /TextFieldProps/);
  assert.match(declarations, /TextFieldType/);
  assert.match(declarations, /TextareaProps/);
  assert.match(declarations, /SelectProps/);
  assert.match(declarations, /SelectOption/);
  assert.match(stylesheet, /\.button--primary/);
  assert.match(stylesheet, /\.ui-dialog-backdrop/);
  assert.match(stylesheet, /\.ui-dialog\s*\{/);
  assert.match(stylesheet, /\.ui-dialog-title/);
  assert.match(stylesheet, /\.ui-dialog-description/);
  assert.match(stylesheet, /\.ui-dialog-actions/);
  assert.match(stylesheet, /--ui-duration-dialog/);
  assert.match(stylesheet, /--ui-duration-normal/);
  assert.match(stylesheet, /--ui-duration-fast/);
  assert.doesNotMatch(stylesheet, /--ui-motion-offset/, "opacity-only floating transitions do not use positional motion tokens");
  assert.match(stylesheet, /\.ui-dialog\[data-ui-dialog-size="narrow"\]/);
  assert.match(stylesheet, /\.ui-dialog\[data-ui-dialog-size="wide"\]/);
  assert.match(stylesheet, /\.ui-dialog\[data-ui-dialog-size="large"\]/);
  assert.match(stylesheet, /\.ui-select-popup:is\(\[data-starting-style\], \[data-ending-style\]\)\s*\{\s*transition-duration:\s*var\(--ui-duration-normal, 150ms\)/);
  assert.match(stylesheet, /--ui-dialog-actions-gap/);
  assert.match(stylesheet, /--ui-dialog-button-gap/);
  assert.doesNotMatch(stylesheet, /transition\s*:\s*all\b/i);
  assert.doesNotMatch(stylesheet, /(?:^|\n)\s*translate\s*:/i, "floating controls fade without a movement transition");
  assert.doesNotMatch(stylesheet, /transition-property\s*:[^;]*\btranslate\b/i);
  assert.doesNotMatch(stylesheet, /(?:^|\n)\s*transition(?:-property)?\s*:[^;]*(?:\bcolor\b|\bbackground\b)/i,
    "theme colors remain synchronous so a switch cannot interpolate an unreadable palette");
  assert.match(stylesheet, /\.icon-button/);
  assert.match(stylesheet, /\.search-field/);
  assert.match(stylesheet, /\.ui-text-control/);
  assert.match(stylesheet, /border:\s*1px solid var\(--ui-border-default, var\(--ui-border-control\)\)/);
  assert.match(stylesheet, /font-family:\s*var\(--ui-font-interface\)/);
  assert.match(stylesheet, /--cmp-text-control-caret:\s*var\(--ui-caret-foreground\)/);
  assert.match(stylesheet, /caret-color:\s*var\(--cmp-text-control-caret\)/);
  assert.match(stylesheet, /--ui-selection-foreground/);
  assert.match(stylesheet, /\.ui-text-control:is\(\[aria-invalid="true"\], \[aria-invalid="grammar"\], \[aria-invalid="spelling"\]\)/);
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
    createElement(TextField, {type: "number", name: "offset", min: -4, max: 8, step: "any", defaultValue: "2", required: true, "aria-invalid": "grammar"}),
    createElement(Textarea, {name: "summary", placeholder: "补充说明", defaultValue: "故事梗概"}),
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
  assert.match(html, /type="number"/);
  assert.match(html, /name="offset"/);
  assert.match(html, /min="-4"[^>]*max="8"[^>]*step="any"/);
  assert.match(html, /aria-invalid="grammar"/);
  assert.match(html, /<textarea[^>]*name="summary"[^>]*class="ui-text-control ui-textarea"/);
  assert.match(html, /placeholder="补充说明"[^>]*rows="3"/);
  assert.match(html, /故事梗概/);
  assert.match(html, /class="ui-select-trigger"/);
  assert.match(html, /选择目录/);
  assert.match(html, /项目根目录/);
  assert.equal(closedDialog, "", "a closed dialog is safe to render without browser globals");
  assert.match(dialogActions, /<div[^>]*class="ui-dialog-actions"[^>]*>/);
  assert.match(dialogActions, /data-testid="dialog-actions"/);
  assert.equal(closeElement.type, DialogClose, "DialogClose is available as a public React component");
  assert.equal(closeElement.props.variant, "secondary");
});

test("Dialog accepts controlled open and busy props as a React component", () => {
  const onOpenChange = () => {};
  const element = createElement(Dialog, {
    open: true,
    onOpenChange,
    title: "处理中",
    busy: true,
  }, createElement(DialogClose, null, "关闭"));

  assert.equal(element.type, Dialog, "Dialog remains a public React component");
  assert.equal(element.props.open, true, "open is supplied by the owning component");
  assert.equal(element.props.onOpenChange, onOpenChange, "open changes are reported to the owner");
  assert.equal(element.props.busy, true, "busy is supplied by the owning operation state");
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
  assert.doesNotMatch(stylesheet, /\.ui-text-control:where\(:hover, :active\)[^{]*\{[^}]*border-color\s*:/s);
  assert.doesNotMatch(stylesheet, /\.ui-select-trigger:where\(\[data-variant="field"\]\):where\(:hover/);
  assert.doesNotMatch(stylesheet, /\.search-field:where\(:hover\)[^{]*\{[^}]*border-color\s*:/s);
  // The four roles deliberately differ from their legacy default aliases in custom themes.
  for (const role of ["action.foreground", "state.disabledForeground", "selection.foreground", "caret.foreground"]) {
    assert.ok(consumed.includes(registry.colors.find(color => color.id === role).cssVariable), role);
  }
  for (const [name, value] of Object.entries({
    "--ui-radius-control": "0.375rem",
    "--ui-radius-row": "0.25rem",
    "--ui-radius-overlay": "0.375rem",
    "--ui-radius-dialog": "0.5rem",
    "--ui-duration-fast": "150ms",
    "--ui-duration-normal": "150ms",
    "--ui-duration-dialog": "150ms",
    "--ui-motion-offset": "0px",
  })) assert.ok(geometry.includes(`${name}: ${value};`), `${name} has the new shared value`);
});

test("selected controls have no check marker and mixed text Buttons retain a dash", async () => {
  const stylesheet = await readFile(new URL(import.meta.resolve("@lodestory/ui/styles.css")), "utf8");
  const selectSource = await readFile(new URL("../packages/ui/src/Select.tsx", import.meta.url), "utf8");

  assert.match(stylesheet, /\.button:where\(\[aria-pressed\]\)\s*\{[^}]*padding-inline-end:/s,
    "text buttons reserve marker space while their aria-pressed state can be mixed");
  assert.doesNotMatch(stylesheet, /\.button:where\(\[aria-pressed="true"\], \[aria-pressed="mixed"\], \[aria-selected="true"\]\)::after/,
    "ordinary selected text buttons do not show a check marker");
  assert.doesNotMatch(stylesheet, /clip-path:\s*polygon\(/, "selected controls do not draw a check with a pseudo-element");
  assert.match(stylesheet, /\.button:where\(\[aria-pressed="mixed"\]\)::after\s*\{[^}]*height:\s*2px;/s,
    "the mixed marker is a short solid dash");
  assert.doesNotMatch(selectSource, /BaseSelect\.ItemIndicator|ui-select-indicator|Icon name="check"/,
    "selected Select options have no tick icon");
  assert.match(stylesheet, /\.ui-select-option:where\(\[data-selected\]\)\s*\{[^}]*color:\s*var\(--ui-state-selected-foreground\);\s*background:\s*var\(--ui-surface-selected\)/s,
    "selected Select options remain identifiable by their state colors");
  assert.doesNotMatch(stylesheet, /\.icon-button:where\(\[aria-pressed\], \[aria-selected\]\)/,
    "IconButton does not reserve marker padding or a gap");
  assert.doesNotMatch(stylesheet, /\.icon-button[^}]*::after|\.icon-button[^}]*\}\s*::after/s,
    "IconButton does not draw a duplicate selected marker");
  assert.doesNotMatch(stylesheet, /border:\s*1px solid var\(--ui-accent-indicator\)/,
    "selected controls do not use an accent border marker");
});
