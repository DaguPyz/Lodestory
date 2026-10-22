import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const uiDist = fileURLToPath(new URL("../packages/ui/dist/", import.meta.url));

function loadDialogWithBaseUiStub() {
  const modules = new Map();
  const dialogParts = Object.fromEntries(
    ["Root", "Portal", "Backdrop", "Popup", "Title", "Description", "Close"]
      .map(name => [name, Symbol(`BaseDialog.${name}`)]),
  );
  const BaseDialog = dialogParts;
  const React = {
    createContext(defaultValue) {
      const context = {value: defaultValue};
      context.Provider = {context};
      return context;
    },
    useContext(context) { return context.value; },
  };
  const jsxRuntime = {
    jsx(type, props) {
      if (type?.context) type.context.value = props.value;
      return {type, props};
    },
    jsxs(type, props) {
      if (type?.context) type.context.value = props.value;
      return {type, props};
    },
  };

  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      require(specifier) {
        if (specifier === "@base-ui/react/dialog") return {Dialog: BaseDialog};
        if (specifier === "react") return React;
        if (specifier === "react/jsx-runtime") return jsxRuntime;
        if (specifier.startsWith(".")) return load(resolve(dirname(path), specifier));
        throw new Error(`Unexpected import '${specifier}' from ${path}`);
      },
    }, {filename: path});
    return exports;
  }

  return {...load(resolve(uiDist, "Dialog.js")), BaseDialog};
}

test("Dialog busy state cancels dismissal and DialogClose forwards disabled, ref, and button type", () => {
  const {Dialog, DialogClose, BaseDialog} = loadDialogWithBaseUiStub();
  const changes = [];
  let cancelled = 0;
  const busyTree = Dialog({
    open: true,
    onOpenChange(open) { changes.push(open); },
    title: "处理中",
    busy: true,
    children: null,
  });
  const root = busyTree.props.children;
  const popup = root.props.children.props.children[1];

  assert.equal(popup.props["aria-modal"], "true", "modal popup exposes its modal semantics for host coordination");
  root.props.onOpenChange(false, {cancel() { cancelled += 1; }});
  assert.equal(root.props.disablePointerDismissal, true);
  assert.equal(cancelled, 1);
  assert.deepEqual(changes, []);

  const ref = {current: null};
  const busyClose = DialogClose({ref, disabled: false, variant: "secondary", children: "关闭"});
  assert.equal(busyClose.type, BaseDialog.Close);
  assert.equal(busyClose.props.disabled, true, "busy disables DialogClose");
  assert.equal(busyClose.props.ref, ref, "DialogClose forwards its button ref to Base UI");
  assert.equal(busyClose.props.render.type.name, "Button");
  assert.equal(busyClose.props.render.props.type, "button", "DialogClose cannot submit its owner's form");
  assert.equal(busyClose.props.render.props.children, "关闭");

  const idleTree = Dialog({
    open: true,
    onOpenChange(open) { changes.push(open); },
    title: "空闲",
    busy: false,
    children: null,
  });
  const idleRoot = idleTree.props.children;
  idleRoot.props.onOpenChange(false, {cancel() { cancelled += 1; }});
  assert.deepEqual(changes, [false], "idle close requests reach the owning component");
  assert.equal(cancelled, 1, "idle close requests are not cancelled");

  const explicitlyDisabled = DialogClose({ref, disabled: true, children: "不可用"});
  assert.equal(explicitlyDisabled.props.disabled, true, "an explicit disabled prop is preserved");
});
