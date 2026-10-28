import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture, flushStartup} from "./helpers/mainStartupFixture.mjs";

function persistenceFixture({failFirstRead = false, deferAxisSave = false, failEventCreate = false, deferEventCreate = false} = {}) {
  const disk = new Map();
  let readFailed = false;
  const calls = [];
  let axisSaveStartedResolve;
  let finishAxisSave;
  let eventCreateStartedResolve;
  let finishEventCreate;
  const axisSaveStarted = new Promise(resolve => { axisSaveStartedResolve = resolve; });
  const eventCreateStarted = new Promise(resolve => { eventCreateStartedResolve = resolve; });
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
        if (args.path.startsWith(".lodestory/timeline/events/") && failEventCreate) throw new Error("事件目录不可写");
        if (args.path.startsWith(".lodestory/timeline/events/") && deferEventCreate && !finishEventCreate) {
          eventCreateStartedResolve();
          return new Promise(resolve => {
            finishEventCreate = () => {
              if (disk.has(key)) throw new Error("文件已存在");
              disk.set(key, Array.from(args.bytes));
              resolve({path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)});
            };
          });
        }
        if (disk.has(key)) {
          if (args.acceptIdentical && JSON.stringify(disk.get(key)) === JSON.stringify(args.bytes)) return {path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)};
          throw new Error("文件已存在");
        }
        disk.set(key, Array.from(args.bytes));
        return {path: args.path, fileName: args.path.split("/").at(-1), bytes: disk.get(key)};
      }
      if (command === "save_project_file" || command === "delete_project_file") {
        const key = keyOf(args.projectPath, args.path);
        if (command === "save_project_file" && deferAxisSave
          && args.path.startsWith(".lodestory/timeline/axes/") && !finishAxisSave) {
          axisSaveStartedResolve();
          return new Promise(resolve => {
            finishAxisSave = () => {
              if (JSON.stringify(disk.get(key)) !== JSON.stringify(args.expectedBytes)) throw new Error("磁盘内容已经改变");
              disk.set(key, Array.from(args.bytes));
              resolve();
            };
          });
        }
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
      if (command === "list_documents") return [];
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  return {f, disk, bytesOf, keyOf, calls, axisSaveStarted, finishAxisSave: () => finishAxisSave?.(),
    eventCreateStarted, finishEventCreate: () => finishEventCreate?.()};
}

function services(f) {
  const workbench = f.getService(f.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const documents = f.getService(f.requireSdk("@lodestory/sdk/documents").documentsKey);
  const storageKey = f.requireSdk("@lodestory/sdk/project-storage").projectStorageKey;
  const storage = f.getService(storageKey);
  const layout = f.getService(f.requireSdk("@lodestory/sdk/layout").layoutKey);
  const contribution = layout.getSnapshot().contents.find(entry => entry.id === "outline-design.navigation");
  const canvasContribution = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main");
  const timelines = f.getService(f.requireSdk("@lodestory/sdk/timeline").timelineKey);
  const model = () => timelines.getModel(workbench.getSnapshot().session.id);
  const outline = f.loadModule("plugins/outline-design/outlineDesignPlugin.tsx").createOutlineDesignPlugin();
  const canvasKey = f.requireSdk("@lodestory/sdk/canvas").canvasKey;
  assert.ok(outline.requires.includes(f.requireSdk("@lodestory/sdk/timeline").timelineKey), "outline consumes the public timeline capability");
  assert.ok(!outline.requires.includes(storageKey), "outline does not own project file storage");
  assert.ok(!outline.requires.includes(canvasKey), "outline does not own the canvas viewport");
  assert.ok(!outline.requires.includes(f.requireSdk("@lodestory/sdk/documents").documentsKey), "outline does not require documents");
  return {workbench, documents, storage, layout, timelines, contribution, canvasContribution, model};
}

const project = {id: "book", name: "故事", path: "/projects/book"};

async function waitForStartup(workbench) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const snapshot = workbench.getSnapshot();
    if (!snapshot.busy || snapshot.loading?.error) return snapshot;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("workbench startup did not settle");
}

async function openReadyProject(workbench, target) {
  assert.equal(await workbench.openProject(target), true);
  const snapshot = await waitForStartup(workbench);
  assert.equal(snapshot.loading?.error ?? null, null, snapshot.loading?.error?.message ?? "project startup failed");
  assert.equal(snapshot.busy, false);
  return snapshot;
}

test("timeline owns the main canvas and one session-only viewport per timeline while outline only navigates", async () => {
  const {f} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, layout, timelines, contribution, canvasContribution, model} = services(f);
  assert.ok(canvasContribution, "timeline registers its canvas through the main layout role");
  assert.equal(canvasContribution.role, "main");
  assert.equal(canvasContribution.order, 10);
  assert.ok(contribution, "outline registers navigation separately from the timeline main view");
  assert.strictEqual(contribution.render({active: true}).props.timelines, timelines,
    "outline consumes the public timeline capability rather than a private model import");
  await openReadyProject(workbench, project);
  const sessionId = workbench.getSnapshot().session.id;
  const listModel = model();

  async function createTimeline(title) {
    listModel.beginCreate();
    listModel.updateCreateDraft({title});
    assert.equal(await listModel.create(), true);
    return listModel.getSnapshot().selectedId;
  }
  function canvasElement() {
    const active = layout.getSnapshot().shownIds.includes("timeline.main");
    const element = canvasContribution.render({active});
    return {props: element.props, tree: element.type(element.props)};
  }

  const firstId = await createTimeline("第一条时间线");
  const firstViewport = canvasElement().props.sessions.get(sessionId).viewports.get(firstId);
  assert.ok(firstViewport);
  assert.equal(firstViewport.getSnapshot().center.x, 0);
  assert.equal(firstViewport.getSnapshot().center.y, 0);
  firstViewport.panBy(120, -40);
  firstViewport.zoomTo(2);
  const nav = contribution.render({active: true});
  layout.show("outline-design.navigation");
  assert.ok(layout.getSnapshot().shownIds.includes("body-editor.main"), "showing the outline navigation alone preserves the current main view");
  assert.equal(timelines.open(sessionId, firstId), true);
  assert.ok(layout.getSnapshot().shownIds.includes("outline-design.navigation"), "opening the canvas leaves the outline navigation visible");
  assert.ok(layout.getSnapshot().shownIds.includes("timeline.main"), "timeline selection switches the main contribution to the canvas");
  const timelineResource = canvasElement().props.sessions.get(sessionId);
  assert.equal(timelineResource.openGeneration, 1, "explicitly opening the canvas triggers one entrance");
  assert.equal(timelines.open(sessionId, firstId), true);
  assert.equal(timelineResource.openGeneration, 1, "opening the already visible timeline does not replay it");
  assert.equal(canvasElement().tree.props.active, true);
  layout.show("body-editor.main");
  assert.equal(canvasElement().tree.props.active, false, "hiding the canvas pauses its gestures");
  layout.show("timeline.main");
  assert.equal(canvasElement().tree.props.active, true);

  listModel.beginCreate();
  assert.equal(canvasElement().tree.props.active, false, "the open create dialog pauses canvas input");
  listModel.cancelCreate();
  const secondId = await createTimeline("第二条时间线");
  assert.equal(await timelines.open(sessionId, secondId), true);
  assert.equal(timelineResource.openGeneration, 2, "opening a newly selected timeline triggers a new entrance");
  const viewports = canvasElement().props.sessions.get(sessionId).viewports;
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

  await openReadyProject(workbench, {...project, id: "other", path: "/projects/other"});
  assert.equal(firstViewport.getSnapshot().disposed, true, "switching projects disposes every old-session viewport");
  assert.equal(canvasElement().tree.props.className, "timeline-canvas-empty", "a new session cannot display the previous project's canvas");
  assert.equal(await workbench.closeProject(), true);
  await f.createdCores.at(-1).unmountAll();
});

test("outline persists only list fields through shared project bytes and reads them in a fresh project session", async () => {
  const {f, disk, bytesOf, keyOf} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, documents, storage, layout, model} = services(f);
  await openReadyProject(workbench, project);
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
  await openReadyProject(workbench, project);
  assert.notStrictEqual(model(), firstModel);
  assert.deepEqual(Array.from(model().getSnapshot().entries, entry => [entry.id, entry.title, entry.summary]), [[draft.id, "归乡", "带着家书，返回北境。"]]);
  assert.equal(await model().remove(draft.id), true);
  assert.equal(disk.has(keyOf(project.path, timelinePath)), false);
  assert.equal(await workbench.closeProject(), true);
  await openReadyProject(workbench, project);
  assert.equal(model().getSnapshot().entries.length, 0, "deleted records stay removed in the next session");
  await openReadyProject(workbench, {...project, id: "other", path: "/projects/other"});
  assert.equal(model().getSnapshot().entries.length, 0, "another project has a separate collection");
  await f.createdCores.at(-1).unmountAll();
});

test("an initial outline read failure blocks project startup and retries through the workbench", async () => {
  const {f} = persistenceFixture({failFirstRead: true});
  f.start(); await flushStartup();
  const {workbench, model} = services(f);
  assert.equal(await workbench.openProject(project), true, "the editor route commits before timeline initialization settles");
  const failed = await waitForStartup(workbench);
  assert.equal(failed.session, null, "a failed initial read does not expose a partial session");
  assert.equal(failed.busy, true, "startup remains locked while recovery is available");
  assert.equal(failed.loading.error.participantId, "timeline");
  assert.match(failed.loading.error.message, /暂时无法读取时间线目录/);

  assert.equal(await workbench.retryProject(), true);
  const retried = await waitForStartup(workbench);
  assert.equal(retried.loading, null);
  assert.equal(retried.busy, false);
  assert.equal(model().getSnapshot().loaded, true, "retry creates a fresh timeline model after the initial read succeeds");
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
  await openReadyProject(workbench, project);
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
  await openReadyProject(workbench, project);
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

test("timeline commands reject new drafts during an awaited leave flush and preserve existing drafts when leave is rejected", async () => {
  const {f, axisSaveStarted, finishAxisSave} = persistenceFixture({deferAxisSave: true});
  f.start(); await flushStartup();
  const {workbench, layout, timelines, model} = services(f);
  await openReadyProject(workbench, project);
  const sessionId = workbench.getSnapshot().session.id;
  const listModel = model();
  listModel.beginCreate();
  listModel.updateCreateDraft({title: "保留的草稿"});
  assert.equal(await workbench.closeProject(), false);
  assert.equal(listModel.getSnapshot().createDraft.title, "保留的草稿");
  listModel.cancelCreate();

  listModel.beginCreate();
  listModel.updateCreateDraft({title: "已提交时间线"});
  assert.equal(await listModel.create(), true);
  const timelineId = listModel.getSnapshot().selectedId;
  assert.equal(timelines.open(sessionId, timelineId), true);
  const canvasContribution = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main");
  const resources = canvasContribution.render({active: true}).props.sessions.get(sessionId);
  const axis = resources.axes.get(timelineId);
  assert.equal(await axis.load(), true);
  assert.equal(await axis.update({origin: 0, step: 5, unit: "年"}), true);
  const update = axis.update({origin: 100, step: 5, unit: "年"});
  await axisSaveStarted;
  assert.equal(axis.getSnapshot().dirty, true);

  const close = workbench.closeProject();
  assert.equal(workbench.getSnapshot().busy, true);
  assert.equal(listModel.beginCreate(), null, "the session facade rejects a new draft while leave awaits axis persistence");
  listModel.updateCreateDraft({title: "不应进入项目切换的窗口"});
  assert.equal(listModel.getSnapshot().createDraft, null);
  finishAxisSave();
  assert.equal(await update, true);
  assert.equal(await close, true);
  assert.equal(listModel.getSnapshot().createDraft, null, "no draft is lost when the session closes");
  await f.createdCores.at(-1).unmountAll();
});

test("timeline event counts and ranges load from project storage and return after reopening the project", async () => {
  const {f} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, layout, model} = services(f);
  await openReadyProject(workbench, project);
  const list = model();
  list.beginCreate();
  list.updateCreateDraft({title: "事件统计"});
  assert.equal(await list.create(), true);
  const timelineId = list.getSnapshot().selectedId;
  const sessionId = workbench.getSnapshot().session.id;
  const resources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(sessionId);
  const axis = resources.axes.get(timelineId);
  const events = resources.events.get(timelineId);
  assert.equal(await Promise.all([axis.load(), events.load()]).then(results => results.every(Boolean)), true);
  assert.equal(await axis.update({origin: 100, step: 5, unit: "年"}), true);
  assert.equal(await events.upsert({id: "00000000-0000-4000-8000-000000000201", title: "离开故乡", summary: "", offset: -18, placement: "above", important: false, assetIds: []}), true);
  assert.equal(await events.upsert({id: "00000000-0000-4000-8000-000000000202", title: "归来", summary: "", offset: 23, placement: "below", important: true, assetIds: []}), true);
  assert.equal(list.getSnapshot().entries[0].eventCount, 2);
  assert.equal(list.getSnapshot().entries[0].period, "82–123 年");

  assert.equal(await workbench.closeProject(), true);
  await openReadyProject(workbench, project);
  const restoredList = model();
  const restoredSessionId = workbench.getSnapshot().session.id;
  const restoredResources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(restoredSessionId);
  const restoredAxis = restoredResources.axes.get(timelineId);
  const restoredEvents = restoredResources.events.get(timelineId);
  assert.ok(restoredAxis && restoredEvents);
  assert.equal(await Promise.all([restoredAxis.load(), restoredEvents.load()]).then(results => results.every(Boolean)), true);
  assert.equal(restoredList.getSnapshot().entries[0].eventCount, 2);
  assert.equal(restoredList.getSnapshot().entries[0].period, "82–123 年");
  await f.createdCores.at(-1).unmountAll();
});

test("timeline summaries reuse unchanged entries and only scan the changed timeline", async () => {
  const {f} = persistenceFixture();
  f.start(); await flushStartup();
  const {workbench, layout, timelines, storage, model} = services(f);
  await openReadyProject(workbench, project);
  const list = model();
  const sessionId = workbench.getSnapshot().session.id;
  const resources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(sessionId);
  const ids = [];
  for (const title of ["第一条", "第二条"]) {
    list.beginCreate(); list.updateCreateDraft({title});
    assert.equal(await list.create(), true);
    ids.push(list.getSnapshot().selectedId);
  }
  const [firstId, secondId] = ids;
  await Promise.all(ids.flatMap(id => [resources.axes.get(id).load(), resources.events.get(id).load()]));
  const event = (id, offset) => ({id, title: "事件", summary: "", offset, placement: "above", important: false, assetIds: []});
  const first = event("00000000-0000-4000-8000-000000000211", 10);
  const second = event("00000000-0000-4000-8000-000000000212", 200);
  assert.equal(await resources.events.get(firstId).upsert(first), true);
  assert.equal(await resources.events.get(secondId).upsert(second), true);

  const geometry = f.loadModule("plugins/timeline/timelineAxisGeometry.ts");
  const convert = geometry.timelineValueAtOffset;
  const converted = [];
  geometry.timelineValueAtOffset = (offset, settings) => { converted.push(offset); return convert(offset, settings); };
  const before = list.getSnapshot();
  let notifications = 0;
  const unsubscribe = list.subscribe(() => notifications++);
  try {
    assert.ok(await storage.getFiles(sessionId).create("无关正文.md", Array.from(new TextEncoder().encode("正文"))));
    assert.strictEqual(list.getSnapshot(), before, "unrelated bytes preserve the public list snapshot");
    assert.equal(notifications, 0);
    assert.equal(timelines.open(sessionId, firstId), true);
    assert.strictEqual(list.getSnapshot().entries, before.entries, "selection does not rebuild entries");
    assert.deepEqual(converted, [], "selection and unrelated notifications do not scan any events");

    const added = event("00000000-0000-4000-8000-000000000213", 20);
    assert.equal(await resources.events.get(firstId).upsert(added), true);
    const changed = list.getSnapshot();
    assert.equal(changed.entries.find(entry => entry.id === firstId).eventCount, 2);
    assert.equal(changed.entries.find(entry => entry.id === firstId).period, "10–20 天");
    assert.strictEqual(changed.entries.find(entry => entry.id === secondId), before.entries.find(entry => entry.id === secondId));
    assert.deepEqual(converted, [10, 20], "one content update scans only that timeline once, including its save transitions");

    converted.length = 0;
    assert.equal(await resources.axes.get(firstId).update({origin: 100, step: 5, unit: "年"}), true);
    assert.equal(list.getSnapshot().entries.find(entry => entry.id === firstId).period, "110–120 年");
    assert.deepEqual(converted, [10, 20], "axis changes rescan only the affected timeline");
    assert.strictEqual(list.getSnapshot().entries.find(entry => entry.id === secondId), before.entries.find(entry => entry.id === secondId));
  } finally {
    geometry.timelineValueAtOffset = convert;
    unsubscribe();
    await f.createdCores.at(-1).unmountAll();
  }
  assert.equal(resources.summaries.size, 0, "session disposal releases summary caches");
});

test("a failed event write blocks project leave and retains its event draft", async () => {
  const {f} = persistenceFixture({failEventCreate: true});
  f.start(); await flushStartup();
  const {workbench, layout, model} = services(f);
  await openReadyProject(workbench, project);
  const list = model();
  list.beginCreate();
  list.updateCreateDraft({title: "保留事件"});
  assert.equal(await list.create(), true);
  const timelineId = list.getSnapshot().selectedId;
  const sessionId = workbench.getSnapshot().session.id;
  const resources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(sessionId);
  const events = resources.events.get(timelineId);
  assert.equal(await events.load(), true);
  assert.equal(await events.upsert({id: "00000000-0000-4000-8000-000000000203", title: "不能丢失", summary: "待重试", offset: 4, placement: "above", important: false, assetIds: []}), false);
  assert.equal(events.getSnapshot().dirty, true);
  assert.equal(events.getSnapshot().events[0].title, "不能丢失");
  assert.equal(await workbench.closeProject(), false);
  assert.equal(workbench.getSnapshot().session.id, sessionId);
  assert.equal(list.getSnapshot().entries[0].eventCount, 1);
  assert.equal(events.getSnapshot().events[0].summary, "待重试");
  await f.createdCores.at(-1).unmountAll();
});

test("deleting a timeline waits for dirty events to reach project storage", async () => {
  const {f, disk, keyOf, eventCreateStarted, finishEventCreate} = persistenceFixture({deferEventCreate: true});
  f.start(); await flushStartup();
  const {workbench, layout, model} = services(f);
  await openReadyProject(workbench, project);
  const list = model();
  list.beginCreate();
  list.updateCreateDraft({title: "删除前保存"});
  assert.equal(await list.create(), true);
  const timelineId = list.getSnapshot().selectedId;
  const sessionId = workbench.getSnapshot().session.id;
  const resources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(sessionId);
  const events = resources.events.get(timelineId);
  assert.equal(await events.load(), true);
  const upsert = events.upsert({id: "00000000-0000-4000-8000-000000000206", title: "保存后删除", summary: "", offset: -3, placement: "above", important: false, assetIds: []});
  await eventCreateStarted;
  const remove = list.remove(timelineId);
  await Promise.resolve();
  assert.ok(list.getSnapshot().entries.some(entry => entry.id === timelineId), "metadata remains until the event write finishes");
  finishEventCreate();
  assert.equal(await upsert, true);
  assert.equal(await remove, true);
  assert.equal(disk.has(keyOf(project.path, `.lodestory/outline-design/timelines/${timelineId}.json`)), false);
  const storedEvents = disk.get(keyOf(project.path, `.lodestory/timeline/events/${timelineId}.json`));
  assert.ok(storedEvents, "the saved event file remains recoverable after timeline metadata removal");
  assert.equal(JSON.parse(new TextDecoder().decode(new Uint8Array(storedEvents))).events[0].title, "保存后删除");
  await f.createdCores.at(-1).unmountAll();
});

test("event flush keeps list commands closed while the workbench is busy and disposes its session subscription", async () => {
  const {f, eventCreateStarted, finishEventCreate, calls} = persistenceFixture({deferEventCreate: true});
  f.start(); await flushStartup();
  const {workbench, layout, model} = services(f);
  await openReadyProject(workbench, project);
  const list = model();
  list.beginCreate();
  list.updateCreateDraft({title: "离开时保存"});
  assert.equal(await list.create(), true);
  const timelineId = list.getSnapshot().selectedId;
  const sessionId = workbench.getSnapshot().session.id;
  const resources = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main").render({active: true}).props.sessions.get(sessionId);
  const events = resources.events.get(timelineId);
  assert.equal(await events.load(), true);
  const upsert = events.upsert({id: "00000000-0000-4000-8000-000000000204", title: "离开前的事件", summary: "", offset: 1, placement: "below", important: false, assetIds: []});
  await eventCreateStarted;
  const metadataCreatesBeforeLeave = calls.filter(call => call.command === "create_project_file" && call.args.path.startsWith(".lodestory/outline-design/timelines/")).length;
  const close = workbench.closeProject();
  assert.equal(workbench.getSnapshot().busy, true);
  assert.equal(list.beginCreate(), null);
  list.updateCreateDraft({title: "不能写入"});
  assert.equal(list.getSnapshot().createDraft, null);
  assert.equal(calls.filter(call => call.command === "create_project_file" && call.args.path.startsWith(".lodestory/outline-design/timelines/")).length, metadataCreatesBeforeLeave);
  finishEventCreate();
  assert.equal(await upsert, true);
  assert.equal(await close, true);
  assert.equal(events.getSnapshot().blocked, true);
  let notifications = 0;
  events.subscribe(() => notifications++);
  assert.equal(await events.upsert({id: "00000000-0000-4000-8000-000000000205", title: "已关闭", summary: "", offset: 2, placement: "above", important: false, assetIds: []}), false);
  assert.equal(notifications, 0);
  await f.createdCores.at(-1).unmountAll();
});

test("timeline receives the current session asset catalog and keeps opaque asset IDs across removal and reopen", async () => {
  const {f, disk, bytesOf, keyOf} = persistenceFixture();
  const assetTypeId = "10000000-0000-4000-8000-000000000001";
  const assetId = "10000000-0000-4000-8000-000000000002";
  const assetSchemaPath = ".lodestory/assets/schema.json";
  disk.set(keyOf(project.path, assetSchemaPath), bytesOf(JSON.stringify({
    format: "lodestory.asset-schema",
    schemaVersion: 2,
    types: [{id: assetTypeId, name: "人物", description: "故事人物", order: 0, status: "active"}],
    assets: [{id: assetId, name: "林遥", description: "主角", typeId: assetTypeId, values: {}}],
    fields: [],
  })));
  f.start(); await flushStartup();
  const {workbench, layout, storage, timelines, model} = services(f);
  const assetCatalogKey = f.requireSdk("@lodestory/sdk/asset-catalog").assetCatalogKey;
  const assetCatalogService = f.getService(assetCatalogKey);
  assert.ok(assetCatalogService, "asset management publishes its public session catalog service");
  await openReadyProject(workbench, project);

  const createSelectedTimeline = async () => {
    const list = model();
    if (list.getSnapshot().entries.length === 0) {
      list.beginCreate();
      list.updateCreateDraft({title: "人物关联"});
      assert.equal(await list.create(), true);
    }
    return list.getSnapshot().selectedId;
  };
  const currentSessionId = workbench.getSnapshot().session.id;
  const timelineId = await createSelectedTimeline();
  const timelineMain = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main");
  const catalog = assetCatalogService.getCatalog(currentSessionId);
  assert.ok(catalog);
  assert.equal(catalog.getSnapshot().loaded, true);
  assert.deepEqual(Array.from(catalog.getSnapshot().assets, asset => asset.id), [assetId]);
  const renderCanvas = () => {
    const mainElement = timelineMain.render({active: true});
    return mainElement.type(mainElement.props);
  };
  assert.strictEqual(renderCanvas().props.assetCatalog, catalog,
    "timeline.main resolves the public catalog for the active project session before passing it to its canvas");

  const timelineResources = timelineMain.render({active: true}).props.sessions.get(currentSessionId);
  const events = timelineResources.events.get(timelineId);
  assert.equal(await events.load(), true);
  const eventId = "00000000-0000-4000-8000-000000000207";
  assert.equal(await events.upsert({id: eventId, title: "林遥返乡", summary: "", offset: 2, placement: "above", important: false, assetIds: [assetId]}), true);
  assert.equal(await workbench.closeProject(), true);
  assert.equal(assetCatalogService.getCatalog(currentSessionId), null, "closing the project releases its catalog");

  await openReadyProject(workbench, project);
  const restoredSessionId = workbench.getSnapshot().session.id;
  assert.equal(timelines.open(restoredSessionId, timelineId), true);
  const restoredCatalog = assetCatalogService.getCatalog(restoredSessionId);
  assert.ok(restoredCatalog);
  assert.notStrictEqual(restoredCatalog, catalog);
  assert.deepEqual(Array.from(restoredCatalog.getSnapshot().assets, asset => asset.id), [assetId]);
  const restoredTimelineEntry = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main");
  const restoredMainElement = restoredTimelineEntry.render({active: true});
  assert.strictEqual(restoredMainElement.type(restoredMainElement.props).props.assetCatalog, restoredCatalog,
    "the canvas receives the catalog belonging to the restored session");
  const restoredResources = restoredMainElement.props.sessions.get(restoredSessionId);
  const restoredEvents = restoredResources.events.get(timelineId);
  assert.equal(await restoredEvents.load(), true);
  assert.deepEqual(Array.from(restoredEvents.getSnapshot().events[0].assetIds), [assetId], "the event association survives close and reopen");

  const files = storage.getFiles(restoredSessionId);
  const schemaFile = files.getSnapshot().files.find(file => file.path === assetSchemaPath);
  assert.ok(schemaFile);
  const schema = JSON.parse(new TextDecoder().decode(new Uint8Array(schemaFile.bytes)));
  assert.equal(files.write(assetSchemaPath, bytesOf(JSON.stringify({...schema, assets: []}))), true);
  assert.equal(await files.save(assetSchemaPath), true);
  assert.equal(restoredCatalog.getSnapshot().assets.some(asset => asset.id === assetId), false,
    "the catalog reflects an asset removed through the project's canonical file buffer");
  assert.deepEqual(Array.from(restoredEvents.getSnapshot().events[0].assetIds), [assetId],
    "asset removal does not rewrite the timeline's opaque reference");

  assert.equal(await workbench.closeProject(), true);
  await openReadyProject(workbench, project);
  const finalSessionId = workbench.getSnapshot().session.id;
  assert.equal(timelines.open(finalSessionId, timelineId), true);
  const finalCatalog = assetCatalogService.getCatalog(finalSessionId);
  assert.deepEqual(Array.from(finalCatalog.getSnapshot().assets), []);
  const finalTimelineEntry = layout.getSnapshot().contents.find(entry => entry.id === "timeline.main");
  const finalMainElement = finalTimelineEntry.render({active: true});
  const finalResources = finalMainElement.props.sessions.get(finalSessionId);
  const finalEvents = finalResources.events.get(timelineId);
  assert.equal(await finalEvents.load(), true);
  assert.deepEqual(Array.from(finalEvents.getSnapshot().events[0].assetIds), [assetId],
    "the unresolved asset ID remains persisted after a second project session");
  await f.createdCores.at(-1).unmountAll();
});
