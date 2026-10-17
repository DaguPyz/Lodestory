import { DocumentSession } from "./DocumentSession";
import { documentErrorMessage, readDocument, saveDocument, type DocumentRecord, type WorkspaceDocument } from "./documentApi";

export type DocumentWorkspaceSnapshot = Readonly<{
  documents: readonly Readonly<WorkspaceDocument>[];
  activeId: string | null;
  currentDocument: Readonly<WorkspaceDocument> | undefined;
  openingPath: string | null;
  error: string | null;
}>;

export type DocumentWorkspaceOptions = {
  /** Return false while the workbench is checking a project transition. */
  canMutate?: () => boolean;
};

export type OpenCreatedOptions = {
  /** Allow an already-started create operation to finish during a transition check. */
  internal?: boolean;
};

export type DocumentWorkspace = {
  getSnapshot: () => DocumentWorkspaceSnapshot;
  subscribe: (listener: () => void) => () => void;
  open: (path: string) => Promise<boolean>;
  openCreated: (record: DocumentRecord, options?: OpenCreatedOptions) => boolean;
  close: (id: string) => Promise<boolean>;
  select: (id: string | null) => boolean;
  update: (id: string, content: string) => boolean;
  save: (id: string) => Promise<boolean>;
  saveAll: () => Promise<boolean>;
  clearError: () => void;
  dispose: () => Promise<void>;
};

const emptySnapshot: DocumentWorkspaceSnapshot = Object.freeze({
  documents: Object.freeze([]),
  activeId: null,
  currentDocument: undefined,
  openingPath: null,
  error: null,
});

/** Create a document session owned by one project/workbench session. */
export function createDocumentWorkspace(
  projectPath: string,
  options: DocumentWorkspaceOptions = {},
): DocumentWorkspace {
  const sessions = new Map<string, DocumentSession>();
  const listeners = new Set<() => void>();
  const canMutate = options.canMutate ?? (() => true);
  let openingSequence = 0;
  let activeId: string | null = null;
  let openingPath: string | null = null;
  let error: string | null = null;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let snapshot: DocumentWorkspaceSnapshot = emptySnapshot;

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A subscriber must not prevent other subscribers from updating. */ }
    }
  };

  const publish = () => {
    if (disposed) return;
    const documents = Object.freeze([...sessions.values()].map((session) =>
      Object.freeze({ ...session.document }),
    ));
    const currentDocument = documents.find((document) => document.id === activeId);
    snapshot = Object.freeze({
      documents,
      activeId,
      currentDocument,
      openingPath,
      error,
    });
    notify();
  };

  const setError = (value: string | null) => {
    if (disposed) return;
    error = value;
    publish();
  };

  const setActiveId = (value: string | null) => {
    if (disposed) return;
    activeId = value;
    publish();
  };

  const install = (record: DocumentRecord, select = true) => {
    if (disposed) return;
    const id = encodeURIComponent(record.path);
    if (!sessions.has(id)) {
      sessions.set(id, new DocumentSession(
        record,
        (path, content, expectedContent) => saveDocument(projectPath, path, content, expectedContent),
        publish,
      ));
      publish();
    }
    if (select) setActiveId(id);
  };

  const workspace: DocumentWorkspace = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async open(path) {
      if (disposed || !canMutate()) return false;
      const sequence = ++openingSequence;
      error = null;
      const id = encodeURIComponent(path);
      if (sessions.has(id)) {
        openingPath = null;
        setActiveId(id);
        return true;
      }

      openingPath = path;
      publish();
      try {
        const record = await readDocument(projectPath, path);
        if (disposed || sequence !== openingSequence) return false;
        install(record);
        return true;
      } catch (cause) {
        if (!disposed && sequence === openingSequence) setError(documentErrorMessage(cause));
        return false;
      } finally {
        if (!disposed && sequence === openingSequence) {
          openingPath = null;
          publish();
        }
      }
    },

    openCreated(record, openOptions = {}) {
      if (disposed || (!openOptions.internal && !canMutate())) return false;
      openingSequence += 1;
      openingPath = null;
      error = null;
      install(record);
      publish();
      return !disposed;
    },

    async close(id) {
      if (disposed || !canMutate()) return false;
      const session = sessions.get(id);
      if (!session) return true;
      if (!await session.save()) {
        if (!disposed) setActiveId(id);
        return false;
      }
      if (disposed || !canMutate() || sessions.get(id) !== session) return false;
      const ids = [...sessions.keys()];
      const index = ids.indexOf(id);
      sessions.delete(id);
      await session.dispose();
      if (disposed) return true;
      if (activeId === id) activeId = [...sessions.keys()][Math.max(0, index - 1)] ?? null;
      publish();
      return true;
    },

    select(id) {
      if (disposed || !canMutate()) return false;
      if (id !== null && !sessions.has(id)) return false;
      setActiveId(id);
      return true;
    },

    update(id, content) {
      if (disposed || !canMutate()) return false;
      const session = sessions.get(id);
      if (!session) return false;
      session.update(content);
      return true;
    },

    async save(id) {
      if (disposed) return true;
      return sessions.get(id)?.save() ?? true;
    },

    async saveAll() {
      if (disposed) return true;
      const openSessions = [...sessions.values()];
      const results = await Promise.all(openSessions.map((session) => session.save()));
      const failed = openSessions.find((_session, index) => !results[index]);
      if (failed && !disposed) setActiveId(failed.document.id);
      return !failed;
    },

    clearError() {
      if (disposed || error === null) return;
      error = null;
      publish();
    },

    dispose() {
      if (disposal) return disposal;
      if (disposed) return Promise.resolve();
      openingSequence += 1;
      disposed = true;
      const openSessions = [...sessions.values()];
      sessions.clear();
      activeId = null;
      openingPath = null;
      error = null;
      snapshot = emptySnapshot;
      notify();
      disposal = Promise.all(openSessions.map((session) => session.dispose())).then(() => {});
      return disposal;
    },
  };

  return workspace;
}
