import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadControls() {
  const source = readFileSync(new URL("../src/plugins/rich-text-editor/quillSelectControls.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = {exports: {}};
  const context = {
    exports: module.exports,
    module,
    document: {createElement: tag => ({tag, dataset: {}, classList: {add() {}}, append() {}, remove() {}})},
    require(specifier) {
      if (specifier === "react/jsx-runtime") return {jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props})};
      if (specifier === "react-dom/client") return {createRoot(host) {
        const root = {host, renders: [], unmounts: 0, render(value) { this.renders.push(value); }, unmount() { this.unmounts++; }};
        roots.push(root);
        return root;
      }};
      if (specifier === "@lodestory/ui") return {
        Icon: "Icon",
        Select: "Select",
      };
      if (specifier === "./richTextFormatting") return {isRichFontFamily: value => typeof value === "string" && !!value.trim()};
      if (specifier === "./quillSelectModel") return {
        createQuillSelectController: (_quill, onChange) => ({
          getValue: () => null,
          apply: () => false,
          setReadOnly() {},
          destroy() {},
        }),
        createPickerOptions: (_format, values) => values.map(value => ({value, label: value})),
        createSystemFontOptions: () => [{value: "", label: "默认字体"}],
      };
      throw new Error(`Unexpected import '${specifier}'`);
    },
  };
  const roots = [];
  vm.runInNewContext(compiled, context, {filename: "quillSelectControls.tsx"});
  return {createQuillSelectControls: module.exports.createQuillSelectControls, roots};
}

function createToolbar() {
  const formats = ["header", "size", "color", "background"];
  const pickers = new Map();
  const controls = [];
  const themePickers = [];
  for (const format of formats) {
    const nativeSelect = {options: [{value: ""}, {value: "1"}], remove() {}};
    const group = {classList: {add() {}}, querySelector: () => nativeSelect};
    const picker = {closest: () => group, replaceWith() {}};
    pickers.set(`.ql-picker.ql-${format}`, picker);
    controls.push([`ql-${format}`, nativeSelect]);
    themePickers.push({container: picker});
  }
  return {
    element: {querySelector: selector => pickers.get(selector), prepend() {}},
    quill: {
      getModule: () => ({controls}),
      theme: {pickers: themePickers},
      on() {},
      off() {},
    },
  };
}

test("Quill picker roots use the provided interaction wrapper without recreating their roots", () => {
  const wrap = child => ({type: "InteractionRoot", props: {children: child}});
  const {createQuillSelectControls, roots} = loadControls();
  const {element, quill} = createToolbar();
  const controls = createQuillSelectControls(quill, element, wrap);

  assert.equal(roots.length, 5, "font and formatting pickers keep their existing isolated roots");
  for (const root of roots) {
    const tree = root.renders.at(-1);
    assert.equal(tree.type, "InteractionRoot", "each root uses the provided wrapper");
    assert.equal(tree.props.children.type, "Select", "each root uses the shared UI component");
  }

  controls.setFamilies(["Arial"]);
  assert.equal(roots.length, 5, "updating picker options reuses the same roots");
  assert.equal(roots[0].renders.at(-1).type, "InteractionRoot");

  controls.destroy();
  assert.deepEqual(roots.map(root => root.unmounts), [1, 1, 1, 1, 1]);
});
