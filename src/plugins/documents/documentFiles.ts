import type {ProjectFile, ProjectFiles} from "@lodestory/sdk/project-storage";

/** Text-only view used inside documents. The shared storage service remains byte-oriented. */
export type DocumentTextFile = Readonly<Pick<ProjectFile, "path" | "fileName" | "dirty" | "saveState" | "saveError"> & {
  content: string;
}>;

export type DocumentTextSnapshot = Readonly<{
  files: readonly DocumentTextFile[];
  blocked: boolean;
  error: string | null;
}>;

export type DocumentTextFiles = {
  getSnapshot(): DocumentTextSnapshot;
  subscribe(listener: () => void): () => void;
  open(path: string): Promise<DocumentTextFile | null>;
  create(parentPath: string, name: string, content?: string): Promise<DocumentTextFile | null>;
  createDirectory(parentPath: string, name: string): Promise<string | null>;
  update(path: string, content: string): boolean;
  save(path: string): Promise<boolean>;
  delete(path: string, options?: {discardChanges?: boolean}): Promise<boolean>;
  clearError(): void;
  dispose?(): void;
};

type CachedTextFile = {source: ProjectFile; file: DocumentTextFile};

const invalidTextMessage = "文件不是有效的 UTF-8 文本，未对其内容进行修改。";
const bytesOf = (content: string) => Array.from(new TextEncoder().encode(content));
const pathOf = (parentPath: string, name: string) => parentPath ? `${parentPath}/${name}` : name;

function decode(source: ProjectFile): DocumentTextFile {
  const content = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(Uint8Array.from(source.bytes));
  return Object.freeze({
    path: source.path, fileName: source.fileName, content, dirty: source.dirty,
    saveState: source.saveState, saveError: source.saveError,
  });
}

/** Adapts only paths explicitly opened or created by documents; unrelated binary files are ignored. */
export function createDocumentFiles(source: ProjectFiles): DocumentTextFiles {
  const listeners = new Set<() => void>();
  const ownedPaths = new Set<string>();
  const decoded = new Map<string, CachedTextFile>();
  const issues = new Map<string, string>();
  let error: string | null = null;
  let disposed = false;
  let snapshot: DocumentTextSnapshot = Object.freeze({files: Object.freeze([]), blocked: source.getSnapshot().blocked, error});

  function notify() {
    if (disposed) return;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (cause) { console.error("Document file subscriber failed.", {error: cause}); }
    }
  }
  function refresh() {
    const sourceSnapshot = source.getSnapshot();
    const byPath = new Map(sourceSnapshot.files.map(file => [file.path, file]));
    const nextFiles: DocumentTextFile[] = [];
    for (const path of ownedPaths) {
      const file = byPath.get(path);
      if (!file) { decoded.delete(path); issues.delete(path); continue; }
      const cached = decoded.get(path);
      if (cached?.source === file) { nextFiles.push(cached.file); continue; }
      try {
        const text = decode(file);
        decoded.set(path, {source: file, file: text});
        issues.delete(path);
        nextFiles.push(text);
      } catch {
        decoded.delete(path);
        issues.set(path, invalidTextMessage);
      }
    }
    const next = Object.freeze({files: Object.freeze(nextFiles), blocked: sourceSnapshot.blocked, error});
    const previous = snapshot;
    const sameFiles = previous.files.length === next.files.length && previous.files.every((file, index) => file === next.files[index]);
    snapshot = Object.freeze({files: sameFiles ? previous.files : next.files, blocked: next.blocked, error: next.error});
    if (!sameFiles || previous.blocked !== snapshot.blocked || previous.error !== snapshot.error) notify();
  }
  function captureError(fallback: string) {
    error = source.getSnapshot().error ?? fallback;
    refresh();
  }
  function projectFile(file: ProjectFile | null, path: string): DocumentTextFile | null {
    if (!file) return null;
    try {
      const text = decode(file);
      ownedPaths.add(path);
      decoded.set(path, {source: file, file: text});
      issues.delete(path);
      error = null;
      refresh();
      return decoded.get(path)?.file ?? text;
    } catch {
      issues.set(path, invalidTextMessage);
      error = invalidTextMessage;
      refresh();
      return null;
    }
  }
  function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return Promise.resolve(operation()); }
    catch (cause) { return Promise.reject(cause); }
  }

  const unsubscribe = source.subscribe(refresh);
  const adapter: DocumentTextFiles = Object.freeze({
    getSnapshot() {
      const blocked = source.getSnapshot().blocked;
      return blocked === snapshot.blocked ? snapshot : Object.freeze({...snapshot, blocked});
    },
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open(path: string) {
      error = null;
      refresh();
      // Start the shared read synchronously so accepted document work is visible to leave checks.
      return invoke(() => source.read(path)).then(file => {
        if (!file) { captureError("无法读取文档。"); return null; }
        const text = projectFile(file, path);
        if (!text) captureError(issues.get(path) ?? invalidTextMessage);
        return text;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "无法读取文档。");
        return null;
      });
    },
    create(parentPath: string, name: string, content = "") {
      const path = pathOf(parentPath, name);
      error = null;
      refresh();
      // Encode only the text explicitly supplied by documents; storage never guesses an encoding.
      return invoke(() => source.create(path, bytesOf(content))).then(file => {
        if (!file) { captureError("无法创建文档。"); return null; }
        const text = projectFile(file, path);
        if (!text) captureError(issues.get(path) ?? invalidTextMessage);
        return text;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "无法创建文档。");
        return null;
      });
    },
    createDirectory(parentPath: string, name: string) {
      const path = pathOf(parentPath, name);
      error = null;
      refresh();
      return invoke(() => source.createDirectory(path)).then(created => {
        if (!created) { captureError("无法创建目录。"); return null; }
        error = null;
        refresh();
        return path;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "无法创建目录。");
        return null;
      });
    },
    update(path: string, content: string) {
      if (!ownedPaths.has(path) || typeof content !== "string") return false;
      error = null;
      const accepted = source.write(path, bytesOf(content));
      if (!accepted) error = source.getSnapshot().error;
      refresh();
      return accepted;
    },
    save(path: string) {
      // Explicit flush remains available while the workbench is transitioning.
      return invoke(() => source.save(path)).then(saved => {
        if (!saved) captureError(source.getSnapshot().files.find(file => file.path === path)?.saveError ?? "文档保存失败。");
        else { error = null; refresh(); }
        return saved;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "文档保存失败。");
        return false;
      });
    },
    delete(path: string, options = {}) {
      return invoke(() => source.delete(path, options)).then(deleted => {
        if (!deleted) { captureError("文档删除失败。"); return false; }
        ownedPaths.delete(path);
        decoded.delete(path);
        issues.delete(path);
        error = null;
        refresh();
        return true;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "文档删除失败。");
        return false;
      });
    },
    clearError() {
      if (error !== null) { error = null; refresh(); }
      source.clearError();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  });
  refresh();
  return adapter;
}
