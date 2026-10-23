import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function persistenceFixture({failFirstRead = false} = {}) {
  const disk = new Map();
  let readFailed = false;
  const calls = [];
  const keyOf = (projectPath, path) => JSON.stringify([projectPath, path]);
  const bytesOf = value => Array.from(new TextEncoder().encode(value));
  const f = createMainFixture({
    async invokeHandler(command, args) {
      calls.push({command, args});
      if (command === "read_project_file") {
        const key = keyOf(args.projectPath, args.path);
        if (!disk.has(key)) throw new Error("文件不存在");
        return {path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)};
      }
      if (command === "create_project_file") {
        const key = keyOf(args.projectPath, args.path);
        if (disk.has(key)) {
          if (args.acceptIdentical && JSON.stringify(disk.get(key)) === JSON.stringify(args.bytes)) return {path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)};
          throw new Error("文件已存在");
        }
        disk.set(key, Array.from(args.bytes));
        return {path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)};
      }
      if (command === "save_project_file" || command === "delete_project_file") {
        const key = keyOf(args.projectPath, args.path);
        if (JSON.stringify(disk.get(key)) !== JSON.stringify(args.expectedBytes)) throw new Error("磁盘内容已经改变");
        if (command === "delete_project_file") disk.delete(key);
        else disk.set(key, Array.from(args.bytes));
        return;
      }
      if (command === "list_project_directory") {
        if (failFirstRead && args.path === ".lodestory/outline-design/timelines" && !readFailed) {
          readFailed = true;
          throw new Error("暂时无法读取时间线目录");
        }
        const prefix = `${args.path}/`;
        const directEntries = new Map();
        let exists = false;
        for (const [key] of disk) {
          const [projectPath, filePath] = JSON.parse(key);
          if (projectPath !== args.projectPath || !filePath.startsWith(prefix)) continue;
          exists = true;
          const child = filePath.slice(prefix.length);
          const separator = child.indexOf("/");
          const name = separator < 0 ? child : child.slice(0, separator);
          const entryPath = `${args.path}/${name}`;
          if (separator >= 0) directEntries.set(entryPath, {path: entryPath, name, kind: "directory", size: null});
          else if (!directEntries.has(entryPath)) directEntries.set(entryPath, {path: entryPath, name, kind: "file", size: disk.get(key).length});
        }
        return {exists, entries: [...directEntries.values()], issues: []};
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  return {f, disk, bytesOf, keyOf, calls};
}

function services(f) {
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const documents = f.getService(f.requireSdk("@lodestory/sdk/documents").documentsKey);
  const storageKey = f.requireSdk("@lodestory/sdk/project-storage").projectStorageKey;
  const storage = f.getService(storageKey);
  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const contribution = layout.getSnapshot().contents.find(entry => entry.id === "outline-design.navigation");
  const canvasContribution = layout.getSnapshot().contents.find(entry => entry.id === "outline-design.canvas");
  const canvas = f.getService(f.requireSdk("@lodestory/sdk/canvas").canvasKey);
  const model = () => contribution.render({active: true}).props.models.get(workbench.getSnapshot().session.id);
  const outline = f.loadModule("plugins/outline-design/outlineDesignPlugin.tsx").createOutlineDesignPlugin();
  assert.ok(outline.requires.includes(storageKey), "outline declares its storage dependency");
  assert.ok(!outline.requires.includes(f.requireSdk("@lodestory/sdk/documents").documentsKey), "outline does not require documents");
  return {workbench, documents, storage, layout, canvas, contribution, canvasContribution, model};
}

const project = {id: "book", name: "故事", path: "/projects/book"};

test("outline opens its main canvas with a separate session-only viewport for each timeline", async () => {
  const {f} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, layout, canvas, contribution, canvasContribution, model} = services(f);
  assert.ok(canvasContribution, "outline registers its canvas through the main layout role");
  assert.equal(canvasContribution.role, "main");
  assert.equal(canvasContribution.order, 10);
  assert.ok(contribution, "outline keeps its navigation contribution separate");
  assert.equal(await workbench.openProject(project), true);
  const sessionId = workbench.getSnapshot().session.id;
  const listModel = model();

  async function createTimeline(title) {
    listModel.beginCreate();
    listModel.updateCreateDraft({title});
    assert.equal(await listModel.create(), true);
    return listModel.getSnapshot().selectedId;
  }
  function canvasElement() {
    const active = layout.getSnapshot().shownIds.includes("outline-design.canvas");
    const element = canvasContribution.render({active});
    return {props: element.props, tree: element.type(element.props)};
  }
  function currentSurface() {
    const {tree} = canvasElement();
    const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
    return children.find(child => child?.type === canvas.Surface);
  }

  const firstId = await createTimeline("第一条时间线");
  const firstViewport = canvasElement().props.viewports.get(sessionId).get(firstId);
  assert.ok(firstViewport);
  assert.equal(firstViewport.getSnapshot().center.x, 0);
  assert.equal(firstViewport.getSnapshot().center.y, 0);
  firstViewport.panBy(120, -40);
  firstViewport.zoomTo(2);
  const nav = contribution.render({active: true});
  layout.show("outline-design.navigation");
  assert.ok(layout.getSnapshot().shownIds.includes("body-editor.main"), "showing the outline navigation alone preserves the current main view");
  nav.props.onOpenTimeline(sessionId, firstId);
  assert.ok(layout.getSnapshot().shownIds.includes("outline-design.navigation"), "opening the canvas leaves the outline navigation visible");
  assert.ok(layout.getSnapshot().shownIds.includes("outline-design.canvas"), "timeline selection switches the main contribution to the canvas");
  assert.equal(currentSurface().props.active, true);
  layout.show("body-editor.main");
  assert.equal(currentSurface().props.active, false, "hiding the canvas pauses its gestures");
  layout.show("outline-design.canvas");
  assert.equal(currentSurface().props.active, true);

  listModel.beginCreate();
  assert.equal(currentSurface().props.active, false, "the open create dialog pauses canvas input");
  listModel.cancelCreate();
  const secondId = await createTimeline("第二条时间线");
  const viewports = canvasElement().props.viewports.get(sessionId);
  const secondViewport = viewports.get(secondId);
  assert.ok(secondViewport);
  assert.notStrictEqual(secondViewport, firstViewport);
  assert.equal(secondViewport.getSnapshot().center.x, 0);
  assert.equal(secondViewport.getSnapshot().center.y, 0);
  assert.equal(secondViewport.getSnapshot().zoom, 1);
  assert.equal(secondViewport.getSnapshot().disposed, false);
  assert.equal(firstViewport.getSnapshot().center.x, -120, "returning to the first timeline retains its view");
  assert.equal(firstViewport.getSnapshot().center.y, 40);
  assert.equal(firstViewport.getSnapshot().zoom, 2);

  assert.equal(await listModel.remove(secondId), true);
  assert.equal(listModel.getSnapshot().selectedId, firstId, "deleting the selected item selects the adjacent timeline");
  assert.equal(secondViewport.getSnapshot().disposed, true);
  assert.equal(viewports.has(secondId), false, "a deleted timeline releases its viewport");
  assert.strictEqual(viewports.get(firstId), firstViewport);

  assert.equal(await workbench.openProject({...project, id: "other", path: "/projects/other"}), true);
  assert.equal(firstViewport.getSnapshot().disposed, true, "switching projects disposes every old-session viewport");
  assert.equal(canvasElement().tree.props.className, "outline-design-canvas-empty", "a new session cannot display the previous project's canvas");
  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("outline persists only list fields through shared project bytes and reads them in a fresh project session", async () => {
  const {f, disk, bytesOf, keyOf} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, documents, storage, layout, model} = services(f);
  assert.equal(await workbench.openProject(project), true);
  const session = workbench.getSnapshot().session;
  const workspace = documents.getWorkspace(session.id);
  const projectFiles = storage.getFiles(session.id);
  assert.ok(projectFiles, "project storage exposes the canonical project byte buffers");
  disk.set(keyOf(project.path, "第一章.md"), bytesOf("正文原文"));
  assert.equal(await workspace.open("第一章.md"), true);
  const documentId = workspace.getSnapshot().documents[0].id;
  assert.equal(workspace.getSnapshot().documents[0].content, "正文原文");
  assert.equal(workspace.update(documentId, "正文与存储共享的内容"), true);
  assert.equal(workspace.getSnapshot().documents[0].content, "正文与存储共享的内容", "documents workspace reads the canonical project-storage buffer");
  const storedBody = projectFiles.getSnapshot().files.find(file => file.path === "第一章.md");
  assert.equal(new TextDecoder().decode(new Uint8Array(storedBody.bytes)), "正文与存储共享的内容", "document edits update the same storage-owned byte buffer");
  assert.equal(await workspace.save(documentId), true);
  assert.equal(new TextDecoder().decode(new Uint8Array(disk.get(keyOf(project.path, "第一章.md")))), "正文与存储共享的内容");
  const documentSnapshot = workspace.getSnapshot();
  const firstModel = model();
  assert.equal(firstModel.getSnapshot().loaded, true);
  assert.equal(firstModel.getSnapshot().entries.length, 0);
  const draft = firstModel.beginCreate();
  assert.ok(draft);
  firstModel.updateCreateDraft({title: "  归乡  ", summary: "带着家书，返回北境。"});
  assert.equal(await firstModel.create(), true);
  const timelinePath = `.lodestory/outline-design/timelines/${draft.id}.json`;
  const timelineBytes = disk.get(keyOf(project.path, timelinePath));
  assert.ok(timelineBytes);
  const stored = JSON.parse(new TextDecoder().decode(new Uint8Array(timelineBytes)));
  assert.deepEqual(Object.keys(stored).sort(), ["format", "schemaVersion", "id", "title", "summary", "createdAt", "updatedAt"].sort());
  assert.equal(stored.title, "归乡");
  assert.equal(stored.summary, "带着家书，返回北境。");
  assert.equal(stored.id, draft.id);
  assert.equal(stored.createdAt, stored.updatedAt);
  assert.strictEqual(workspace.getSnapshot(), documentSnapshot, "timeline creation does not change manuscript tabs or selection");
  layout.show("outline-design.navigation");
  layout.show("project-management.files");
  assert.strictEqual(model(), firstModel, "hiding the panel retains the project model");

  assert.equal(await workbench.closeProject(), true);
  assert.equal(firstModel.beginCreate(), null, "closed-session handles cannot accept new work");
  assert.equal(storage.getFiles(session.id), null);
  assert.equal(await workbench.openProject(project), true);
  assert.notStrictEqual(model(), firstModel);
  assert.deepEqual(Array.from(model().getSnapshot().entries, entry => [entry.id, entry.title, entry.summary]), [[draft.id, "归乡", "带着家书，返回北境。"]]);
  assert.equal(await model().remove(draft.id), true);
  assert.equal(disk.has(keyOf(project.path, timelinePath)), false);
  assert.equal(await workbench.closeProject(), true);
  assert.equal(await workbench.openProject(project), true);
  assert.equal(model().getSnapshot().entries.length, 0, "deleted records stay removed in the next session");
  assert.equal(await workbench.openProject({...project, id: "other", path: "/projects/other"}), true);
  assert.equal(model().getSnapshot().entries.length, 0, "another project has a separate collection");
  await f.createdCores.at(-1).unmountAll();
});

test("an initial outline read failure remains visible without preventing project opening and can be retried", async () => {
  const {f} = persistenceFixture({failFirstRead: true});
  f.start(); await flushStartup();
  const {workbench, model} = services(f);
  assert.equal(await workbench.openProject(project), true);
  assert.equal(model().getSnapshot().loaded, false);
  assert.match(model().getSnapshot().error, /暂时无法读取/);
  assert.equal(model().beginCreate(), null, "unread storage cannot be mistaken for a known empty collection");
  assert.equal(await model().retry(), true);
  assert.equal(model().getSnapshot().loaded, true);
  assert.equal(model().getSnapshot().error, null);
  await f.createdCores.at(-1).unmountAll();
});

test("bad UTF-8 and bad JSON stay untouched while other timeline files remain readable", async () => {
  const {f, disk, bytesOf, keyOf, calls} = persistenceFixture();
  const validId = "00000000-0000-4000-8000-000000000101";
  const utf8Id = "00000000-0000-4000-8000-000000000102";
  const jsonId = "00000000-0000-4000-8000-000000000103";
  const directory = ".lodestory/outline-design/timelines";
  const record = id => ({
    format: "lodestory.timeline-list-entry", schemaVersion: 1, id, title: "可读时间线", summary: "",
    createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:00:00.000Z",
  });
  const paths = [
    `${directory}/${validId}.json`,
    `${directory}/${utf8Id}.json`,
    `${directory}/${jsonId}.json`,
  ];
  const originalBytes = [bytesOf(JSON.stringify(record(validId))), [0xff, 0xfe], bytesOf("{not-json")];
  paths.forEach((path, index) => disk.set(keyOf(project.path, path), originalBytes[index]));
  f.start(); await flushStartup();
  const {workbench, model} = services(f);
  assert.equal(await workbench.openProject(project), true);
  const snapshot = model().getSnapshot();
  assert.deepEqual(Array.from(snapshot.entries, entry => entry.id), [validId]);
  assert.ok(snapshot.issues.some(issue => issue.message.includes("UTF-8")));
  assert.ok(snapshot.issues.some(issue => issue.message.includes("JSON")));
  assert.deepEqual(paths.map(path => disk.get(keyOf(project.path, path))), originalBytes);
  assert.equal(calls.some(({command}) => command === "create_project_file" || command === "save_project_file" || command === "delete_project_file"), false);
  await f.createdCores.at(-1).unmountAll();
});

test("an unfinished outline form keeps its project session until the author completes or cancels it", async () => {
  const {f, disk} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, model} = services(f);
  assert.equal(await workbench.openProject(project), true);
  const session = workbench.getSnapshot().session;
  const originalModel = model();
  originalModel.beginCreate();
  originalModel.updateCreateDraft({title: "尚未提交的名称"});
  assert.equal(await workbench.openProject({...project, id: "other", path: "/projects/other"}), false);
  assert.strictEqual(workbench.getSnapshot().session, session);
  assert.equal(originalModel.getSnapshot().createDraft.title, "尚未提交的名称");
  assert.equal([...disk.keys()].some(key => key.includes(".lodestory/outline-design/timelines/")), false, "unsubmitted input is not written as a file");
  originalModel.cancelCreate();
  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});
