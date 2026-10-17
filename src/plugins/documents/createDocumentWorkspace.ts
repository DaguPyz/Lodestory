import type {DocumentSnapshot, DocumentWorkspace, OpenDocument} from "@lodestory/sdk/documents";
import {DocumentSession} from "./DocumentSession";
import {createDocument, documentErrorMessage, readDocument, saveDocument, type DocumentRecord} from "./documentApi";

type Options = {
  canMutate?: () => boolean;
  onReveal?: (documentId: string) => void;
};

/** A controller belongs to the documents plugin; only its service crosses plugin boundaries. */
export function createDocumentWorkspace(projectPath: string, options: Options = {}) {
  const sessions = new Map<string, DocumentSession>();
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  const closing = new Map<string, Promise<boolean>>();
  const canMutate = options.canMutate ?? (() => true);
  let activeId: string | null = null;
  let openingPath: string | null = null;
  let creating = false;
  let error: string | null = null;
  let selection = 0;
  let checkingLeave = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let snapshot: DocumentSnapshot = Object.freeze({
    documents: Object.freeze([]), activeId, openingPath, creating, blocked: !canMutate(), error,
  });

  function blocked() { return disposed || checkingLeave || !canMutate(); }
  function publish() {
    if (disposed) return;
    const nextDocuments = [...sessions.values()].map(session => session.document);
    const previous = snapshot.documents;
    const documents = previous.length === nextDocuments.length && previous.every((value, index) => value === nextDocuments[index])
      ? previous : Object.freeze(nextDocuments);
    const isBlocked = blocked();
    if (snapshot.documents === documents && snapshot.activeId === activeId && snapshot.openingPath === openingPath
      && snapshot.creating === creating && snapshot.blocked === isBlocked && snapshot.error === error) return;
    snapshot = Object.freeze({documents, activeId, openingPath, creating, blocked: isBlocked, error});
    notify();
  }
  function notify() {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (cause) { console.error("Document subscriber failed.", {error: cause}); }
    }
  }
  function reveal(id: string) {
    if (disposed) return;
    try { options.onReveal?.(id); }
    catch (cause) { console.error("Document presentation request failed.", {error: cause}); }
  }
  function activate(id: string, requestReveal = true) {
    activeId = id;
    openingPath = null;
    publish();
    if (requestReveal) reveal(id);
  }
  // Register before running an action: synchronous subscriber reentry must see accepted work.
  function run<T>(action: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const operation = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    try { void action().then(resolve, reject); } catch (cause) { reject(cause); }
    return operation;
  }
  async function drain() {
    const errors: unknown[] = [];
    while (pending.size) {
      for (const result of await Promise.allSettled([...pending])) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    }
    if (errors.length) throw Object.assign(new Error("Document operations could not finish."), {errors});
  }
  function validPath(path: string, allowRoot = false) {
    return typeof path === "string" && (allowRoot && path === "" || path.length > 0 && !/[\\:\u0000-\u001f]/.test(path)
      && path.split("/").every(part => part !== "" && part !== "." && part !== ".."));
  }
  function install(record: DocumentRecord) {
    const id = encodeURIComponent(record.path);
    let session = sessions.get(id);
    if (!session) {
      let previous: OpenDocument;
      session = new DocumentSession(record,
        (path, content, expectedContent) => saveDocument(projectPath, path, content, expectedContent),
        () => {
          const document = session!.document;
          const failed = document.saveState === "error" && previous.saveState !== "error";
          previous = document;
          if (failed && !disposed) {
            selection += 1;
            activeId = id;
            openingPath = null;
          }
          publish();
          if (failed) reveal(id);
        });
      previous = session.document;
      sessions.set(id, session);
    }
    return session;
  }
  async function saveAll() {
    const open = [...sessions.values()];
    const results = await Promise.all(open.map(session => session.save()));
    const failed = open.find((_value, index) => !results[index]);
    if (failed && !disposed) activate(failed.document.id);
    return !failed;
  }

  const service: DocumentWorkspace = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    open(path: string) {
      if (blocked()) return Promise.resolve(false);
      if (!validPath(path)) { error = "文档路径必须位于项目目录内。"; publish(); return Promise.resolve(false); }
      const id = encodeURIComponent(path);
      if (closing.has(id)) return Promise.resolve(false);
      const sequence = ++selection;
      error = null;
      if (sessions.has(id)) { activate(id); return Promise.resolve(true); }
      return run(async () => {
        openingPath = path;
        publish();
        try {
          const record = await readDocument(projectPath, path);
          if (disposed || sequence !== selection) return false;
          activate(install(record).document.id);
          return !disposed;
        } catch (cause) {
          if (!disposed && sequence === selection) { error = documentErrorMessage(cause); publish(); }
          return false;
        } finally {
          if (!disposed && sequence === selection) { openingPath = null; publish(); }
        }
      });
    },
    create(parentPath: string, name: string) {
      if (blocked() || creating) return Promise.resolve(null);
      if (!validPath(parentPath, true) || typeof name !== "string" || !name.trim() || /[\/\\\u0000-\u001f]/.test(name)) {
        error = "文档名称和目录无效。"; publish(); return Promise.resolve(null);
      }
      const sequence = ++selection;
      return run(async () => {
        creating = true;
        openingPath = null;
        error = null;
        publish();
        try {
          const record = await createDocument(projectPath, parentPath, name);
          if (disposed) return null;
          const document = install(record).document;
          if (sequence === selection) activate(document.id);
          else publish();
          return disposed ? null : document;
        } catch (cause) {
          if (!disposed) { error = documentErrorMessage(cause); publish(); }
          return null;
        } finally {
          creating = false;
          publish();
        }
      });
    },
    select(id: string) {
      if (blocked() || closing.has(id) || !sessions.has(id)) return false;
      selection += 1;
      activate(id);
      return true;
    },
    update(id: string, content: string) {
      if (blocked() || closing.has(id) || typeof content !== "string") return false;
      const session = sessions.get(id);
      if (!session) return false;
      session.update(content);
      return true;
    },
    close(id: string) {
      if (blocked()) return Promise.resolve(false);
      const existing = closing.get(id);
      if (existing) return existing;
      const session = sessions.get(id);
      if (!session) return Promise.resolve(true);
      // Lock before save notifications can synchronously reenter update/close.
      let finish!: (value: boolean) => void;
      let fail!: (cause: unknown) => void;
      const operation = new Promise<boolean>((done, reject) => { finish = done; fail = reject; });
      closing.set(id, operation);
      void run(async () => {
        try {
          if (!await session.save()) return false;
          if (disposed || sessions.get(id) !== session) return false;
          const ids = [...sessions.keys()];
          const index = ids.indexOf(id);
          sessions.delete(id);
          if (activeId === id) {
            activeId = [...sessions.keys()][Math.max(0, index - 1)] ?? null;
          }
          await session.dispose();
          publish();
          return true;
        } finally { closing.delete(id); }
      }).then(finish, fail);
      return operation;
    },
    save(id: string) {
      if (disposed) return Promise.resolve(false);
      const session = sessions.get(id);
      return session ? run(() => session.save()) : Promise.resolve(false);
    },
    saveAll() { return disposed ? Promise.resolve(false) : run(saveAll); },
    clearError() {
      if (disposed || error === null) return;
      error = null;
      publish();
    },
  });

  return {
    service,
    refreshBlocked: publish,
    async beforeLeave() {
      if (disposed) return true;
      if (checkingLeave) return false;
      checkingLeave = true;
      publish();
      try {
        await drain();
        return disposed ? true : await saveAll();
      } finally { checkingLeave = false; publish(); }
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      let complete!: () => void;
      let fail!: (cause: unknown) => void;
      disposal = new Promise<void>((done, reject) => { complete = done; fail = reject; });
      disposed = true;
      selection += 1;
      const open = [...sessions.values()];
      sessions.clear();
      snapshot = Object.freeze({documents: Object.freeze([]), activeId: null, openingPath: null, creating: false, blocked: true, error: null});
      notify();
      listeners.clear();
      void Promise.allSettled([drain(), ...open.map(session => session.dispose())]).then(results => {
        if (results.some(result => result.status === "rejected" || result.value === false)) {
          snapshot = Object.freeze({documents: Object.freeze(open.map(session => session.document)), activeId,
            openingPath: null, creating: false, blocked: true, error: "停止时有文档未能保存，草稿已保留。"});
          // Keep a recoverable copy in the lifecycle error even if the host removes the service.
          const failure = new Error("Documents could not be saved while stopping the workspace.");
          Object.defineProperty(failure, "snapshot", {value: snapshot});
          throw failure;
        }
      }).then(complete, fail);
      return disposal;
    },
  };
}
