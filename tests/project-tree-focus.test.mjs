import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function treeButton(element, path) {
  if (!element || typeof element !== "object") return undefined;
  if (element.props?.["data-project-tree-path"] === path) return element;
  if (element.type?.name === "TreeNode") return treeButton(element.type(element.props), path);
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = treeButton(child, path);
    if (result) return result;
  }
}

test("a single click only selects a file; keyboard activation and double-click open it", () => {
  const fixture = createMainFixture();
  const {ProjectTree} = fixture.loadModule("plugins/project-management/ProjectTree.tsx");
  const opened = [], folders = [], focused = [];
  const shortcuts = {subscribe: () => () => {}, getSnapshot: () => ({}), getShortcut: () => "F2"};
  const tree = ProjectTree({
    shortcuts, projectName: "项目", entries: [
      {path: "current.txt", name: "current.txt"},
      {path: "other.txt", name: "other.txt"},
      {path: "notes", name: "notes", children: []},
    ],
    activeDocumentPath: "current.txt", openingPath: null, loading: false, error: null, active: true,
    newDisabled: false, deletingPath: null, lastRename: null,
    onOpenDocument: path => { opened.push(path); }, onSelectFolder: path => { folders.push(path); },
    onNewDocument() {}, onNewDirectory() {}, onDeleteDocument() {}, onRename() {}, onReload() {},
  });
  const event = detail => ({detail, currentTarget: {focus(options) { focused.push(options.preventScroll); }}});
  const current = treeButton(tree, "current.txt");
  const other = treeButton(tree, "other.txt");
  const folder = treeButton(tree, "notes");
  assert.ok(current && other && folder);

  current.props.onClick(event(1));
  other.props.onClick(event(1));
  assert.deepEqual(opened, [], "single clicks do not open either current or unopened files");
  assert.deepEqual(focused, [true, true]);
  current.props.onClick(event(2));
  other.props.onClick(event(0));
  assert.deepEqual(opened, ["current.txt", "other.txt"], "double-click and keyboard activation open the file");
  assert.deepEqual(focused, [true, true, true, true]);
  folder.props.onClick(event(1));
  assert.deepEqual(folders, ["notes"]);
  assert.deepEqual(focused, [true, true, true, true, true], "pointer selection focuses the node even on WebKit");
});
