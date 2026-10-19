import type {DocumentSnapshot, DocumentWorkspace, OpenDocument} from "@lodestory/sdk/documents";
import {DocumentSession} from "./DocumentSession";
import {
  createDocument,
  createDocumentDirectory,
  deleteDocument as deleteDocumentFile,
  documentErrorMessage,
  readDocument,
  saveDocument,
  type DocumentRecord,
} from "./documentApi";

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
  let deletingPath: string | null = null;
  let error: string | null = null;
  let selection = 0;
  let checkingLeave = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let snapshot: DocumentSnapshot = Object.freeze({
    documents: Object.freeze([]), activeId, openingPath, creating, deletingPath, blocked: !canMutate(), error,
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
      && snapshot.creating === creating && snapshot.deletingPath === deletingPath
      && snapshot.blocked === isBlocked && snapshot.error === error) return;
    snapshot = Object.freeze({documents, activeId, openingPath, creating, deletingPath, blocked: isBlocked, error});
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
  function run<T>(action: () => Promise<T>, onAccepted?: () => void): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const operation = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    try {
      onAccepted?.();
      void Promise.resolve().then(action).then(resolve, reject);
    } catch (cause) { reject(cause); }
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
      if (deletingPath === path) return Promise.resolve(false);
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
    createDirectory(parentPath: string, name: string) {
      if (blocked() || creating || deletingPath !== null) return Promise.resolve(null);
      if (!validPath(parentPath, true) || typeof name !== "string" || !name.trim()
        || name !== name.trim() || /[\/\\:\u0000-\u001f]/.test(name) || name === "." || name === "..") {
        error = "目录名称和位置无效。";
        publish();
        return Promise.resolve(null);
      }
      return run(async () => {
        try {
          if (disposed) return null;
          const path = await createDocumentDirectory(projectPath, parentPath, name);
          if (disposed) return null;
          return path;
        } catch (cause) {
          if (!disposed) { error = documentErrorMessage(cause); publish(); }
          return null;
        } finally {
          creating = false;
          publish();
        }
      }, () => {
        creating = true;
        error = null;
        publish();
      });
    },
    saveAs(documentId: string, fileName: string, content: string) {
      if (blocked() || creating) return Promise.reject(new Error("当前不能另存文档。"));
      const source = sessions.get(documentId);
      if (!source || closing.has(documentId) || deletingPath === source.document.path) {
        return Promise.reject(new Error("源文档已关闭或正在删除。"));
      }
      if (typeof content !== "string" || typeof fileName !== "string" || !fileName.trim()
        || fileName !== fileName.trim() || fileName.startsWith(".") || /[\/\\:\u0000-\u001f]/.test(fileName)
        || !/\.(md|markdown|txt|lode)$/i.test(fileName)) {
        return Promise.reject(new Error("另存文件名或内容无效。"));
      }
      const sourcePath = source.document.path;
      const parentPath = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      if (!validPath(parentPath, true)) return Promise.reject(new Error("源文档目录无效。"));
      const targetPath = parentPath ? `${parentPath}/${fileName}` : fileName;
      const targetId = encodeURIComponent(targetPath);
      if (sessions.has(targetId)) return Promise.reject(new Error("同名文档已在工作区打开。"));
      const sequence = ++selection;
      return run(async () => {
        creating = true;
        openingPath = null;
        error = null;
        publish();
        try {
          const record = await createDocument(projectPath, parentPath, fileName, content);
          if (disposed) return;
          const sourceStillOpen = sessions.get(documentId) === source;
          const target = sessions.get(targetId);
          const document = target ? target.document : install(record).document;
          if (sourceStillOpen && sequence === selection) activate(document.id);
          else publish();
        } catch (cause) {
          if (!disposed) { error = documentErrorMessage(cause); publish(); }
          throw cause;
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
      if (!session || deletingPath === session.document.path) return false;
      session.update(content);
      return true;
    },
    deleteDocument(path: string, options: {discardChanges?: boolean} = {}) {
      if (blocked() || deletingPath !== null || creating) return Promise.resolve(false);
      if (!validPath(path)) {
        error = "文档路径必须位于项目目录内。";
        publish();
        return Promise.resolve(false);
      }
      if (openingPath === path) return Promise.resolve(false);
      const id = encodeURIComponent(path);
      if (closing.has(id)) return Promise.resolve(false);
      const session = sessions.get(id);
      if (session && options.discardChanges !== undefined && typeof options.discardChanges !== "boolean") {
        return Promise.resolve(false);
      }

      // Lock before publishing so subscriber reentry cannot edit or start another save.
      let pendingSave: Promise<boolean> = Promise.resolve(true);
      let deleted = false;
      return run(async () => {
        try {
          if (disposed) return false;
          let expectedContent: string;
          if (session) {
            if (!await pendingSave) throw new Error(session.document.saveError ?? "删除前保存失败。文档仍已保留。");
            if (session.isDirty && options.discardChanges !== true) {
              error = "文档有未保存修改；确认后才能删除。";
              return false;
            }
            expectedContent = session.persistedContent;
          } else {
            expectedContent = (await readDocument(projectPath, path)).content;
          }

          await deleteDocumentFile(projectPath, path, expectedContent);
          deleted = true;
          if (session && sessions.get(id) === session) {
            const ids = [...sessions.keys()];
            const index = ids.indexOf(id);
            sessions.delete(id);
            session.finishDelete();
            if (activeId === id) {
              activeId = [...sessions.keys()][Math.max(0, index - 1)] ?? null;
              if (activeId) reveal(activeId);
            }
          }
          error = null;
          return true;
        } catch (cause) {
          if (!disposed) error = documentErrorMessage(cause);
          return false;
        } finally {
          if (session && !deleted) session.cancelDelete(!disposed);
          deletingPath = null;
          publish();
        }
      }, () => {
        pendingSave = session ? session.beginDelete() : Promise.resolve(true);
        deletingPath = path;
        error = null;
        publish();
      });
    },
    close(id: string) {
      if (blocked()) return Promise.resolve(false);
      if (deletingPath !== null && sessions.get(id)?.document.path === deletingPath) return Promise.resolve(false);
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
      if (session && deletingPath === session.document.path) return Promise.resolve(false);
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
      snapshot = Object.freeze({documents: Object.freeze([]), activeId: null, openingPath: null, creating: false,
        deletingPath: null, blocked: true, error: null});
      notify();
      listeners.clear();
      let operationFailure: unknown;
      void drain().catch(cause => { operationFailure = cause; }).then(async () => {
        // Finish accepted operations first; an in-flight delete owns its session and must not race a save.
        const open = [...sessions.values()];
        const results = await Promise.allSettled(open.map(session => session.dispose()));
        sessions.clear();
        if (operationFailure !== undefined || results.some(result => result.status === "rejected" || result.value === false)) {
          const recoverable = open.map(session => session.document);
          snapshot = Object.freeze({documents: Object.freeze(recoverable),
            activeId: recoverable.some(document => document.id === activeId) ? activeId : null,
            openingPath: null, creating: false, deletingPath: null, blocked: true,
            error: "停止时有文档未能保存，草稿已保留。"});
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
