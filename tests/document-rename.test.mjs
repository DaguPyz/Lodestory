import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function createFiles(initialPaths) {
  const listeners = new Set();
  const pathListeners = new Set();
  const files = initialPaths.map(path => ({
    path, fileName: path.split("/").at(-1), content: `原文:${path}`,
    dirty: false, saveState: "saved", saveError: null,
  }));
  const renameStarted = {};
  renameStarted.promise = new Promise(resolve => { renameStarted.resolve = resolve; });
  let pendingRename;
  const calls = [];
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const service = {
    getSnapshot: () => ({files, blocked: false, error: null}),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribePathChanges(listener) { pathListeners.add(listener); return () => pathListeners.delete(listener); },
    async open(path) { return files.find(file => file.path === path) ?? null; },
    update(path, content) {
      const index = files.findIndex(file => file.path === path);
      if (index < 0) return false;
      files[index] = {...files[index], content, dirty: true, saveState: "pending"};
      calls.push(["write", path, content]);
      notify();
      return true;
    },
    async save(path) {
      calls.push(["save", path]);
      const index = files.findIndex(file => file.path === path);
      if (index < 0) return false;
      files[index] = {...files[index], dirty: false, saveState: "saved"};
      notify();
      return true;
    },
    renamePath(fromPath, toPath) {
      calls.push(["rename", fromPath, toPath]);
      renameStarted.resolve();
      return new Promise(resolve => {
        pendingRename = success => {
          if (success) {
            for (const listener of [...pathListeners]) listener({fromPath, toPath});
            for (let index = 0; index < files.length; index += 1) {
              const file = files[index];
              const nextPath = file.path === fromPath ? toPath
                : file.path.startsWith(`${fromPath}/`) ? `${toPath}${file.path.slice(fromPath.length)}` : null;
              if (nextPath) files[index] = {...file, path: nextPath, fileName: nextPath.split("/").at(-1)};
            }
            notify();
          }
          resolve(success);
        };
      });
    },
  };
  return {service, files, calls, renameStarted, finishRename: success => pendingRename(success)};
}

function createWorkspace(files) {
  const fixture = createMainFixture();
  return fixture.loadModule("plugins/documents/createDocumentWorkspace.ts").createDocumentWorkspace(files.service);
}

test("folder rename preserves open descendant tabs, selection, and edits queued during the native rename", async () => {
  const files = createFiles(["notes/one.md", "notes/sub/two.txt", "elsewhere.md"]);
  const workspace = createWorkspace(files);
  await workspace.service.open("elsewhere.md");
  await workspace.service.open("notes/one.md");
  await workspace.service.open("notes/sub/two.txt");
  const activeBefore = workspace.service.getSnapshot().activeId;
  let liveEditorText = "原文:notes/sub/two.txt";
  const oldActiveId = activeBefore;
  workspace.service.registerContentReader(oldActiveId, () => liveEditorText);

  const rename = workspace.service.renamePath("notes", "archive");
  await files.renameStarted.promise;
  assert.equal(workspace.service.getSnapshot().renamingPath, "notes");
  assert.equal(workspace.service.getSnapshot().blocked, true);

  liveEditorText = "重命名期间的最新输入";
  assert.equal(workspace.service.update(oldActiveId, liveEditorText), true);
  const unrelatedId = encodeURIComponent("elsewhere.md");
  assert.equal(workspace.service.update(unrelatedId, "其他文档仍可编辑"), true);
  files.finishRename(true);
  assert.equal(await rename, true);

  const snapshot = workspace.service.getSnapshot();
  assert.deepEqual(Array.from(snapshot.documents, ({path}) => path), ["elsewhere.md", "archive/one.md", "archive/sub/two.txt"]);
  assert.equal(snapshot.activeId, encodeURIComponent("archive/sub/two.txt"));
  assert.equal(snapshot.documents[2].content, "重命名期间的最新输入");
  assert.equal(files.files.find(file => file.path === "archive/sub/two.txt").content, "重命名期间的最新输入");
  assert.equal(files.files.find(file => file.path === "elsewhere.md").content, "其他文档仍可编辑");
  await workspace.dispose();
});

test("a failed destination rename keeps queued editor input on the original path", async () => {
  const files = createFiles(["notes/one.md"]);
  const workspace = createWorkspace(files);
  await workspace.service.open("notes/one.md");
  const id = encodeURIComponent("notes/one.md");
  let liveEditorText = "原文:notes/one.md";
  workspace.service.registerContentReader(id, () => liveEditorText);

  const rename = workspace.service.renamePath("notes", "archive");
  await files.renameStarted.promise;
  liveEditorText = "保留在原路径的输入";
  assert.equal(workspace.service.update(id, liveEditorText), true);
  files.finishRename(false);
  assert.equal(await rename, false);

  const snapshot = workspace.service.getSnapshot();
  assert.equal(snapshot.documents[0].path, "notes/one.md");
  assert.equal(snapshot.documents[0].content, "保留在原路径的输入");
  assert.equal(files.files[0].content, "保留在原路径的输入");
  assert.equal(snapshot.renamingPath, null);
  await workspace.dispose();
});
