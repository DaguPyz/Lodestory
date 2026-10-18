import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function createFixture() {
  const modules = new Map();
  const writes = [];
  const reads = [];
  const creates = [];
  const logs = [];
  const controls = { failWrites: false, rejectReveal: false };
  const documentsKey = Object.freeze({ id: "app/documents" });
  const documentRevealRequested = Object.freeze({ id: "app/documents/reveal-requested" });
  const workbenchKey = Object.freeze({ id: "app/workbench" });
  const makeRecord = (path, content = `content:${path}`) => ({ path, fileName: path.split("/").at(-1), content });

  function resolveModule(fromPath, specifier) {
    const base = resolve(dirname(fromPath), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
      try { readFileSync(candidate, "utf8"); return candidate; }
      catch { /* try the next extension */ }
    }
    throw new Error(`Cannot resolve '${specifier}' from '${fromPath}'.`);
  }

  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      console: { error(...args) { logs.push(args); } },
      setTimeout,
      clearTimeout,
      queueMicrotask,
      require(specifier) {
        if (specifier === "@lodestory/sdk/documents") return { documentsKey, documentRevealRequested };
        if (specifier === "@lodestory/sdk/workbench") return { workbenchKey };
        if (specifier.endsWith("/documentApi") || specifier === "./documentApi") return {
          async readDocument(projectPath, path) {
            reads.push([projectPath, path]);
            return makeRecord(path);
          },
          async createDocument(projectPath, parentPath, name, content) {
            const createGate = controls.createGate;
            if (createGate) await createGate;
            if (controls.failCreates) throw new Error("create failed");
            const path = [parentPath, name].filter(Boolean).join("/");
            creates.push([projectPath, parentPath, name]);
            return makeRecord(path, content ?? `created:${path}`);
          },
          async saveDocument(projectPath, path, content, expectedContent) {
            writes.push([projectPath, path, content, expectedContent]);
            if (controls.failWrites) throw new Error("write failed");
          },
          documentErrorMessage(error) { return error instanceof Error ? error.message : String(error); },
        };
        return load(resolveModule(path, specifier));
      },
    }, { filename: path });
    return exports;
  }

  let state = { session: null, busy: true, active: false };
  const subscribers = new Set();
  const participants = new Map();
  const participationBySession = new Map();
  const workbench = {
    getSnapshot() { return state; },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    registerParticipant(participant) {
      if (participants.has(participant.id)) throw new Error(`Duplicate participant '${participant.id}'.`);
      participants.set(participant.id, participant);
      return async () => {
        participants.delete(participant.id);
        for (const [id, participation] of [...participationBySession]) {
          await participation.dispose();
          participationBySession.delete(id);
        }
      };
    },
  };
  function setWorkbench(next) {
    state = next;
    for (const listener of [...subscribers]) listener();
  }
  const emitted = [];
  const provided = new Map();
  const context = {
    get(key) {
      if (key === workbenchKey) return workbench;
      throw new Error(`Unexpected service key: ${key.id}`);
    },
    provide(key, value) { provided.set(key, value); },
    async emit(key, payload) {
      emitted.push([key, payload]);
      if (key === documentRevealRequested && controls.rejectReveal) throw new Error("reveal listener failed");
    },
  };
  const { createDocumentsPlugin } = load(resolve(sourceRoot, "plugins/documents/documentsPlugin.ts"));
  const plugin = createDocumentsPlugin();

  return {
    controls,
    context,
    creates,
    documentsKey,
    documentRevealRequested,
    emitted,
    logs,
    makeRecord,
    participants,
    participationBySession,
    plugin,
    provided,
    reads,
    setWorkbench,
    workbench,
    writes,
    workbenchKey,
    async activate() { plugin.activate(context); return provided.get(documentsKey); },
    start(session) {
      const participation = participants.get("documents").start(session);
      participationBySession.set(session.id, participation);
      return participation;
    },
  };
}

const projectSession = (id, path) => ({ id, project: { id: `project-${id}`, name: id, path } });

test("the documents plugin owns one workspace per workbench session and removes ended handles", async () => {
  const f = createFixture();
  assert.deepEqual(Array.from(f.plugin.requires), [f.workbenchKey]);
  assert.deepEqual(Array.from(f.plugin.provides), [f.documentsKey]);
  const documents = await f.activate();
  assert.equal(documents.getWorkspace("session-a"), null);

  const firstSession = projectSession("session-a", "/projects/first");
  const firstParticipation = f.start(firstSession);
  const first = documents.getWorkspace(firstSession.id);
  assert.ok(first);
  assert.equal(documents.getWorkspace(firstSession.id), first);
  assert.equal(first.getSnapshot().blocked, true, "a staged workbench session cannot mutate yet");
  assert.throws(() => f.start(firstSession), /cannot be started/i);

  f.setWorkbench({ session: firstSession, busy: false, active: true });
  assert.equal(first.getSnapshot().blocked, false);
  const firstDocument = await first.create("", "第一章.md");
  assert.equal(firstDocument.content, "created:第一章.md");

  const secondSession = projectSession("session-b", "/projects/second");
  f.setWorkbench({ session: secondSession, busy: false, active: true });
  const secondParticipation = f.start(secondSession);
  const second = documents.getWorkspace(secondSession.id);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.getSnapshot().blocked, false);
  await second.open("第一章.md");
  assert.equal(first.getSnapshot().documents[0].content, "created:第一章.md");
  assert.equal(second.getSnapshot().documents[0].content, "content:第一章.md");

  await firstParticipation.dispose();
  f.participationBySession.delete(firstSession.id);
  assert.equal(documents.getWorkspace(firstSession.id), null);
  assert.equal(await first.open("旧会话.md"), false);
  assert.equal(second.getSnapshot().documents.length, 1);

  await secondParticipation.dispose();
  f.participationBySession.delete(secondSession.id);
  assert.equal(documents.getWorkspace(secondSession.id), null);
  await f.plugin.deactivate();
});

test("workbench busy and session changes refresh the workspace mutation gate", async () => {
  const f = createFixture();
  const documents = await f.activate();
  const session = projectSession("session-a", "/projects/first");
  const participation = f.start(session);
  const workspace = documents.getWorkspace(session.id);
  assert.equal(workspace.getSnapshot().blocked, true);

  f.setWorkbench({ session, busy: false, active: true });
  assert.equal(workspace.getSnapshot().blocked, false);
  assert.ok(await workspace.create("", "第一章.md"));

  f.setWorkbench({ session, busy: true, active: true });
  assert.equal(workspace.getSnapshot().blocked, true);
  const id = workspace.getSnapshot().documents[0].id;
  assert.equal(workspace.update(id, "busy 时不能修改"), false);
  f.setWorkbench({ session, busy: false, active: true });
  assert.equal(workspace.getSnapshot().blocked, false);
  assert.equal(workspace.update(id, "允许修改"), true);

  const other = projectSession("session-b", "/projects/second");
  f.setWorkbench({ session: other, busy: false, active: true });
  assert.equal(workspace.getSnapshot().blocked, true, "a stale project session cannot mutate through an old workspace");
  assert.equal(workspace.update(id, "过期修改"), false);
  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("reveal event failures do not undo document operations or turn save failures into rejections", async () => {
  const f = createFixture();
  f.controls.rejectReveal = true;
  const documents = await f.activate();
  const session = projectSession("session-a", "/projects/first");
  const participation = f.start(session);
  f.setWorkbench({ session, busy: false, active: true });
  const workspace = documents.getWorkspace(session.id);

  const created = await workspace.create("", "第一章.md");
  assert.equal(created.path, "第一章.md");
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0][0], f.documentRevealRequested);
  assert.deepEqual({ ...f.emitted[0][1] }, { sessionId: session.id, documentId: created.id });

  workspace.update(created.id, "未保存内容");
  f.controls.failWrites = true;
  assert.equal(await workspace.save(created.id), false);
  assert.equal(workspace.getSnapshot().documents[0].content, "未保存内容");
  await Promise.resolve();
  assert.ok(f.logs.length >= 2, "both event failures should be reported without escaping the operation");

  f.controls.failWrites = false;
  assert.equal(await workspace.save(created.id), true);

  const other = await workspace.create("", "第二章.md");
  assert.ok(other);
  assert.equal(workspace.select(created.id), true);
  const sourceContent = workspace.getSnapshot().documents.find(document => document.id === created.id).content;
  let finishCreate;
  f.controls.createGate = new Promise(resolve => { finishCreate = resolve; });
  const saveAs = workspace.saveAs(created.id, "第一章.lode", "rich-delta-envelope");
  await Promise.resolve();
  f.controls.createGate = null;
  assert.equal(workspace.select(other.id), true);
  finishCreate();
  await saveAs;

  const snapshot = workspace.getSnapshot();
  const savedAs = snapshot.documents.find(document => document.fileName === "第一章.lode");
  assert.equal(savedAs.content, "rich-delta-envelope");
  assert.equal(snapshot.activeId, other.id, "a late create must not steal the current document selection");
  assert.equal(snapshot.documents.find(document => document.id === created.id).content, sourceContent);
  await assert.rejects(workspace.saveAs(created.id, "第一章.lode", "replacement"), /已在工作区打开/);
  assert.equal(workspace.getSnapshot().documents.find(document => document.fileName === "第一章.lode").content, "rich-delta-envelope");
  f.controls.failCreates = true;
  await assert.rejects(workspace.saveAs(created.id, "失败.lode", "failed-envelope"), /create failed/);
  f.controls.failCreates = false;
  assert.equal(workspace.getSnapshot().documents.find(document => document.id === created.id).content, sourceContent);
  await participation.dispose();
  f.participationBySession.delete(session.id);
  await f.plugin.deactivate();
});

test("deactivation invalidates session workspaces and rejects late participant starts", async () => {
  const f = createFixture();
  const documents = await f.activate();
  const participant = f.participants.get("documents");
  const session = projectSession("session-a", "/projects/first");
  const participation = f.start(session);
  const oldWorkspace = documents.getWorkspace(session.id);
  await f.plugin.deactivate();
  assert.equal(documents.getWorkspace(session.id), null);
  assert.equal(await oldWorkspace.open("迟到打开.md"), false);
  assert.throws(() => participant.start(projectSession("late", "/projects/late")), /cannot be started/i);
  await participation.dispose();
});
