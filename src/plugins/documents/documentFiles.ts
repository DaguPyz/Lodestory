import type {ProjectByteView, ProjectFile, ProjectFiles, ProjectPathRename} from "@lodestory/sdk/project-storage";
import {decodeDocumentBytes} from "./decodeDocumentBytes";

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
  subscribePathChanges?(listener: (change: ProjectPathRename) => void): () => void;
  open(path: string): Promise<DocumentTextFile | null>;
  readSearchText(path: string, signal?: AbortSignal): Promise<string | null>;
  create(parentPath: string, name: string, content?: string): Promise<DocumentTextFile | null>;
  createDirectory(parentPath: string, name: string): Promise<string | null>;
  renamePath(fromPath: string, toPath: string): Promise<boolean>;
  update(path: string, content: string): boolean;
  save(path: string): Promise<boolean>;
  delete(path: string, options?: {discardChanges?: boolean}): Promise<boolean>;
  clearError(): void;
  dispose?(): void;
};

type CachedTextFile = {
  byteIdentity: ProjectByteView | ProjectFile["bytes"];
  content: string | null;
  source?: ProjectFile;
  file?: DocumentTextFile;
};
type ProjectByteIdentity = ProjectByteView | ProjectFile["bytes"];
type PendingDecode = {byteIdentity: ProjectByteIdentity; promise: Promise<string>; token: object};

const invalidTextMessage = "文件不是有效的 UTF-8 文本，未对其内容进行修改。";
const ASYNC_DECODE_THRESHOLD = 1024 * 1024;
const textEncoder = new TextEncoder();
const bytesOf = (content: string) => textEncoder.encode(content);
const pathOf = (parentPath: string, name: string) => parentPath ? `${parentPath}/${name}` : name;
const isPlainTextPath = (path: string) => /\.txt$/i.test(path);

type PendingTextProjection = {token: object; bytes: ProjectByteView | Uint8Array; content: string};

type WellFormedStringPrototype = {isWellFormed?: (this: string) => boolean};
const nativeIsWellFormed = (String.prototype as unknown as WellFormedStringPrototype).isWellFormed;

function isWellFormedUtf16(content: string): boolean {
  if (typeof nativeIsWellFormed === "function") return nativeIsWellFormed.call(content);
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function sameArrayBytes(bytes: ProjectFile["bytes"], candidate: Uint8Array): boolean {
  if (bytes.length !== candidate.length) return false;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== candidate[index]) return false;
  }
  return true;
}

function identityOf(file: ProjectFile): ProjectByteIdentity {
  const view = file.byteView;
  return view === undefined ? file.bytes : view;
}

function lengthOf(file: ProjectFile): number {
  const view = file.byteView;
  return view === undefined ? file.bytes.length : view.byteLength;
}

function sameFileBytes(file: ProjectFile, candidate: ProjectByteView | Uint8Array): boolean {
  const view = file.byteView;
  if (view !== undefined) {
    if (view === candidate) return true;
    try { return view.equals(candidate); }
    catch { return false; }
  }
  if (isByteView(candidate)) {
    try { return candidate.equals(file.bytes); }
    catch { return false; }
  }
  return sameArrayBytes(file.bytes, candidate);
}

function isByteView(bytes: ProjectByteView | ProjectFile["bytes"] | Uint8Array): bytes is ProjectByteView {
  return !Array.isArray(bytes) && typeof (bytes as ProjectByteView).copyTo === "function";
}

function decodeContent(bytes: ProjectByteIdentity): string {
  let view: Uint8Array;
  if (isByteView(bytes)) {
    view = new Uint8Array(bytes.byteLength);
    bytes.copyTo(view);
  } else if (bytes[Symbol.iterator] === Array.prototype[Symbol.iterator]) {
    view = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error("文件字节必须是 0 到 255 的整数。");
      }
      view[index] = byte;
    }
  } else {
    // Preserve Uint8Array.from's iterator semantics for noncanonical ProjectFiles inputs.
    view = Uint8Array.from(bytes);
  }
  return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(view);
}

function textFile(source: ProjectFile, content: string): DocumentTextFile {
  return Object.freeze({
    path: source.path, fileName: source.fileName, content, dirty: source.dirty,
    saveState: source.saveState, saveError: source.saveError,
  });
}

/** Adapts only paths explicitly opened or created by documents; unrelated binary files are ignored. */
export function createDocumentFiles(source: ProjectFiles): DocumentTextFiles {
  const listeners = new Set<() => void>();
  const pathChangeListeners = new Set<(change: ProjectPathRename) => void>();
  const ownedPaths = new Set<string>();
  const decoded = new Map<string, CachedTextFile>();
  const pendingDecodes = new Map<string, PendingDecode>();
  const pendingTextProjections = new Map<string, PendingTextProjection>();
  const requestedRenames = new Set<Readonly<{fromPath: string; toPath: string}>>();
  const issues = new Map<string, string>();
  let error: string | null = null;
  let disposed = false;
  let snapshot: DocumentTextSnapshot = Object.freeze({files: Object.freeze([]), blocked: source.getSnapshot().blocked, error});

  function clearCaches() {
    ownedPaths.clear();
    decoded.clear();
    pendingDecodes.clear();
    pendingTextProjections.clear();
    issues.clear();
  }

  function decodeLarge(path: string, byteIdentity: ProjectByteIdentity): Promise<string> {
    const cached = pendingDecodes.get(path);
    if (cached?.byteIdentity === byteIdentity) return cached.promise;
    const token = {};
    const clear = () => {
      if (pendingDecodes.get(path)?.token === token) pendingDecodes.delete(path);
    };
    const promise = decodeDocumentBytes(byteIdentity, () => {
      if (disposed) return false;
      const latest = latestFile(path);
      return latest !== undefined && identityOf(latest) === byteIdentity;
    }).then(
      content => { clear(); return content; },
      cause => { clear(); throw cause; },
    );
    pendingDecodes.set(path, {byteIdentity, promise, token});
    return promise;
  }

  function getTextFile(sourceFile: ProjectFile, path: string): DocumentTextFile | null {
    const byteIdentity = identityOf(sourceFile);
    const cached = decoded.get(path);
    if (cached?.byteIdentity === byteIdentity) {
      if (cached.content === null) return null;
      if (cached.source === sourceFile && cached.file) return cached.file;
      const file = textFile(sourceFile, cached.content);
      cached.source = sourceFile;
      cached.file = file;
      return file;
    }

    try {
      const content = decodeContent(byteIdentity);
      const file = textFile(sourceFile, content);
      decoded.set(path, {byteIdentity, content, source: sourceFile, file});
      return file;
    } catch {
      // Cache decode failures too; unchanged malformed bytes should not be revalidated on every refresh.
      decoded.set(path, {byteIdentity, content: null});
      return null;
    }
  }

  function notify() {
    if (disposed) return;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (cause) { console.error("Document file subscriber failed.", {error: cause}); }
    }
  }
  function rewritePath(path: string, fromPath: string, toPath: string) {
    return path === fromPath ? toPath : path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : null;
  }
  function applyRename(fromPath: string, toPath: string, byPath: ReadonlyMap<string, ProjectFile>) {
    const moves = [...ownedPaths].flatMap(path => {
      const nextPath = rewritePath(path, fromPath, toPath);
      return nextPath && byPath.has(nextPath) ? [{path, nextPath}] : [];
    });
    for (const {path} of moves) ownedPaths.delete(path);
    for (const {path, nextPath} of moves) {
      ownedPaths.add(nextPath);
      const file = byPath.get(nextPath)!;
      const cached = decoded.get(path);
      decoded.delete(path);
      if (cached) {
        const text = cached.content === null ? null : textFile(file, cached.content);
        decoded.set(nextPath, {byteIdentity: identityOf(file), content: cached.content, source: file, ...(text ? {file: text} : {})});
      }
      const issue = issues.get(path);
      issues.delete(path);
      if (issue) issues.set(nextPath, issue);
      pendingTextProjections.delete(path);
      pendingDecodes.delete(path);
    }
  }
  function refresh() {
    if (disposed) return;
    const sourceSnapshot = source.getSnapshot();
    const byPath = new Map(sourceSnapshot.files.map(file => [file.path, file]));
    for (const rename of requestedRenames) {
      const oldExists = [...byPath.keys()].some(path => path === rename.fromPath || path.startsWith(`${rename.fromPath}/`));
      const newExists = [...byPath.keys()].some(path => path === rename.toPath || path.startsWith(`${rename.toPath}/`));
      if (!oldExists && newExists) applyRename(rename.fromPath, rename.toPath, byPath);
    }
    const nextFiles: DocumentTextFile[] = [];
    for (const path of ownedPaths) {
      const file = byPath.get(path);
      if (!file) { decoded.delete(path); issues.delete(path); continue; }
      const pendingProjection = pendingTextProjections.get(path);
      if (pendingProjection && sameFileBytes(file, pendingProjection.bytes)) {
        decoded.set(path, {byteIdentity: identityOf(file), content: pendingProjection.content, source: file});
      }
      const text = getTextFile(file, path);
      if (!text) {
        issues.set(path, invalidTextMessage);
        continue;
      }
      issues.delete(path);
      nextFiles.push(text);
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
  function installTextFile(path: string, text: DocumentTextFile): DocumentTextFile {
    ownedPaths.add(path);
    issues.delete(path);
    error = null;
    refresh();
    return decoded.get(path)?.file ?? text;
  }
  function invalidTextFile(path: string): null {
    issues.set(path, invalidTextMessage);
    error = invalidTextMessage;
    refresh();
    return null;
  }
  function latestFile(path: string): ProjectFile | undefined {
    return source.getSnapshot().files.find(candidate => candidate.path === path);
  }
  async function projectLargeFile(file: ProjectFile, path: string): Promise<DocumentTextFile | null> {
    let content: string;
    const byteIdentity = identityOf(file);
    try {
      content = await decodeLarge(path, byteIdentity);
    } catch {
      if (disposed) return null;
      const latest = latestFile(path);
      if (!latest) return null;
      if (identityOf(latest) !== byteIdentity) return await projectFile(latest, path);
      decoded.set(path, {byteIdentity: identityOf(latest), content: null});
      return invalidTextFile(path);
    }

    if (disposed) return null;
    const latest = latestFile(path);
    if (!latest) return null;
    const latestIdentity = identityOf(latest);
    if (latestIdentity !== byteIdentity) return await projectFile(latest, path);

    const cached = decoded.get(path);
    if (cached?.byteIdentity === latestIdentity) {
      const text = getTextFile(latest, path);
      return text ? installTextFile(path, text) : invalidTextFile(path);
    }
    const text = textFile(latest, content);
    decoded.set(path, {byteIdentity: latestIdentity, content, source: latest, file: text});
    return installTextFile(path, text);
  }
  function projectFile(file: ProjectFile | null, path: string): DocumentTextFile | null | Promise<DocumentTextFile | null> {
    if (!file || disposed) return null;
    const byteIdentity = identityOf(file);
    const cached = decoded.get(path);
    if (!ownedPaths.has(path) && lengthOf(file) >= ASYNC_DECODE_THRESHOLD && cached?.byteIdentity !== byteIdentity) {
      return projectLargeFile(file, path);
    }
    const text = getTextFile(file, path);
    if (!text) {
      return invalidTextFile(path);
    }
    return installTextFile(path, text);
  }
  function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return Promise.resolve(operation()); }
    catch (cause) { return Promise.reject(cause); }
  }

  let unsubscribe = () => {};
  const unsubscribePathChanges = source.subscribePathChanges?.(change => {
    for (const listener of [...pathChangeListeners]) {
      if (!pathChangeListeners.has(listener)) continue;
      try { listener(change); } catch (cause) { console.error("Document path-change subscriber failed.", {error: cause}); }
    }
  }) ?? (() => {});
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
    subscribePathChanges(listener: (change: ProjectPathRename) => void) {
      if (disposed) return () => {};
      pathChangeListeners.add(listener);
      return () => { pathChangeListeners.delete(listener); };
    },
    async readSearchText(path: string, signal?: AbortSignal) {
      if (disposed || signal?.aborted || typeof source.readTransient !== "function") return null;
      try {
        const bytes = await source.readTransient(path);
        if (!bytes || disposed || signal?.aborted) return null;
        return await decodeDocumentBytes(bytes, () => !disposed && !signal?.aborted);
      } catch { return null; }
    },
    open(path: string) {
      error = null;
      refresh();
      // Start the shared read synchronously so accepted document work is visible to leave checks.
      return invoke(() => isPlainTextPath(path)
        ? source.read(path, {preferByteView: true})
        : source.read(path)).then(async file => {
        if (!file) { captureError("无法读取文档。"); return null; }
        const text = await projectFile(file, path);
        if (!text) captureError(issues.get(path) ?? "无法读取文档。");
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
      const bytes = bytesOf(content);
      return invoke(() => isPlainTextPath(path)
        ? source.create(path, bytes, {preferByteView: true})
        : source.create(path, bytes)).then(async file => {
        if (!file) { captureError("无法创建文档。"); return null; }
        const text = await projectFile(file, path);
        if (!text) captureError(issues.get(path) ?? "无法创建文档。");
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
    renamePath(fromPath: string, toPath: string) {
      if (disposed) return Promise.resolve(false);
      const rename = Object.freeze({fromPath, toPath});
      requestedRenames.add(rename);
      return invoke(() => source.renamePath(fromPath, toPath)).then(renamed => {
        if (renamed) refresh();
        return renamed;
      }).catch(cause => {
        captureError(cause instanceof Error ? cause.message : "重命名失败。");
        return false;
      }).finally(() => requestedRenames.delete(rename));
    },
    update(path: string, content: string) {
      if (!ownedPaths.has(path) || typeof content !== "string") return false;
      error = null;
      const encoded = bytesOf(content);
      let bytes: ProjectByteView | Uint8Array = encoded;
      if (isPlainTextPath(path) && source.captureBytes) {
        try { bytes = source.captureBytes(encoded); }
        catch (cause) {
          error = cause instanceof Error ? cause.message : "无法捕获文档字节。";
          refresh();
          return false;
        }
      }
      const token = {};
      if (isWellFormedUtf16(content)) pendingTextProjections.set(path, {token, bytes, content});
      let accepted: boolean;
      try {
        accepted = isPlainTextPath(path)
          ? source.write(path, bytes, {preferByteView: true})
          : source.write(path, bytes);
      } finally {
        if (pendingTextProjections.get(path)?.token === token) pendingTextProjections.delete(path);
      }
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
        pendingDecodes.delete(path);
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
      try { unsubscribe(); }
      finally {
        unsubscribePathChanges();
        pathChangeListeners.clear();
        listeners.clear();
        clearCaches();
      }
    },
  });

  // Subscribe before reading the initial snapshot, then refresh once against the latest state.
  // If initialization fails after subscribing, release the subscription and any retained data.
  let initializing = true;
  try {
    unsubscribe = source.subscribe(() => { if (!initializing) refresh(); });
    initializing = false;
    refresh();
  } catch (cause) {
    initializing = false;
    disposed = true;
    try { unsubscribe(); } catch { /* preserve the initialization error */ }
    listeners.clear();
    clearCaches();
    throw cause;
  }
  return adapter;
}
