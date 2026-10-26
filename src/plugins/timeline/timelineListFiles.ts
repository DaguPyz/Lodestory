import type {ProjectFile, ProjectFileBytes, ProjectFileSnapshot, ProjectFiles} from "@lodestory/sdk/project-storage";

export type TimelineListFile = Readonly<{
  id: string;
  content: string;
  saveState: ProjectFile["saveState"];
  saveError: string | null;
}>;

export type TimelineListFileIssue = Readonly<{name: string; message: string}>;

export type TimelineListFilesSnapshot = Readonly<{
  files: readonly TimelineListFile[];
  issues: readonly TimelineListFileIssue[];
  loaded: boolean;
  loading: boolean;
  creating: boolean;
  deletingId: string | null;
  blocked: boolean;
  error: string | null;
}>;

const DIRECTORY = ".lodestory/outline-design/timelines";
const TIMELINE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

function decodeUtf8(bytes: ProjectFileBytes): string {
  return new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(bytes));
}

function encodeUtf8(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function idFromPath(path: string): string | null {
  if (!path.startsWith(`${DIRECTORY}/`)) return null;
  const name = path.slice(DIRECTORY.length + 1);
  if (!TIMELINE_FILE.test(name)) return null;
  return name.slice(0, -".json".length);
}

function timelinePath(id: string): string {
  return `${DIRECTORY}/${id}.json`;
}

/** Timeline owns this private path and UTF-8 JSON convention; project storage owns the shared bytes. */
export function createTimelineListFiles(source: ProjectFiles) {
  const listeners = new Set<() => void>();
  const decodedByPath = new Map<string, {bytes: ProjectFileBytes; content: string | null}>();
  let knownPaths = new Set<string>();
  let issues: TimelineListFileIssue[] = [];
  let loaded = false;
  let loading = false;
  let creating = false;
  let deletingId: string | null = null;
  let error: string | null = null;
  let alive = true;
  let generation = 0;
  let loadOperation: Promise<boolean> | null = null;
  const initialStorageSnapshot = source.getSnapshot();
  let snapshot: TimelineListFilesSnapshot = Object.freeze({
    files: Object.freeze([]),
    issues: Object.freeze([]),
    loaded: false,
    loading: false,
    creating: false,
    deletingId: null,
    blocked: initialStorageSnapshot.blocked,
    error: initialStorageSnapshot.blocked ? initialStorageSnapshot.error : null,
  });

  function decodeFile(path: string, bytes: ProjectFileBytes): string | null {
    const previous = decodedByPath.get(path);
    if (previous?.bytes === bytes) return previous.content;
    let content: string | null;
    try { content = decodeUtf8(bytes); }
    catch { content = null; }
    decodedByPath.set(path, {bytes, content});
    return content;
  }

  function sameIssues(left: readonly TimelineListFileIssue[], right: readonly TimelineListFileIssue[]): boolean {
    return left.length === right.length && left.every((issue, index) =>
      issue.name === right[index].name && issue.message === right[index].message);
  }

  function buildSnapshot(sourceSnapshot: ProjectFileSnapshot): TimelineListFilesSnapshot {
    const fileByPath = new Map(sourceSnapshot.files.map(file => [file.path, file]));
    const previousSnapshot = snapshot;
    const previousFileById = new Map(previousSnapshot.files.map(file => [file.id, file]));
    const files: TimelineListFile[] = [];
    const nextIssues = [...issues];
    for (const path of knownPaths) {
      const id = idFromPath(path);
      if (!id) continue;
      const file = fileByPath.get(path);
      if (!file) continue;
      const content = decodeFile(path, file.bytes);
      if (content !== null) {
        const previous = previousFileById.get(id);
        files.push(previous && previous.content === content && previous.saveState === file.saveState && previous.saveError === file.saveError
          ? previous
          : Object.freeze({id, content, saveState: file.saveState, saveError: file.saveError}));
      } else {
        if (!nextIssues.some(issue => issue.name === path && issue.message.includes("UTF-8"))) {
          nextIssues.push({name: path, message: "文件不是有效 UTF-8，已保留原始字节。"});
        }
      }
    }
    const previousFiles = previousSnapshot.files;
    const sameFiles = previousFiles.length === files.length
      && previousFiles.every((file, index) => file === files[index]);
    const sameIssueList = sameIssues(previousSnapshot.issues, nextIssues);
    const result = Object.freeze({
      files: sameFiles ? previousFiles : Object.freeze(files),
      issues: sameIssueList ? previousSnapshot.issues : Object.freeze(nextIssues),
      loaded,
      loading,
      creating,
      deletingId,
      blocked: sourceSnapshot.blocked,
      error: error ?? (sourceSnapshot.blocked ? sourceSnapshot.error : null),
    });
    if (result.files === previousSnapshot.files && result.issues === previousSnapshot.issues
      && result.loaded === previousSnapshot.loaded && result.loading === previousSnapshot.loading
      && result.creating === previousSnapshot.creating && result.deletingId === previousSnapshot.deletingId
      && result.blocked === previousSnapshot.blocked && result.error === previousSnapshot.error) return previousSnapshot;
    return result;
  }

  function publish() {
    if (!alive) return;
    const next = buildSnapshot(source.getSnapshot());
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  snapshot = buildSnapshot(initialStorageSnapshot);

  const unsubscribe = source.subscribe(publish);

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loadOperation) return loadOperation;
    const requestGeneration = ++generation;
    loading = true;
    error = null;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    loadOperation = operation;

    // Start the storage read before publishing. A listener may synchronously begin leaving the
    // project from publish(), so storage must already know about this accepted operation.
    let listingOperation: ReturnType<ProjectFiles["list"]>;
    try { listingOperation = source.list(DIRECTORY); }
    catch (cause) { listingOperation = Promise.reject(cause); }

    publish();
    void (async () => {
      try {
        const listing = await listingOperation;
        if (!alive || requestGeneration !== generation) return false;
        if (!listing) {
          const current = source.getSnapshot();
          throw new Error((current.blocked ? current.error : null) ?? "当前项目存储不可用。");
        }

        const nextPaths = new Set<string>();
        const nextIssues: TimelineListFileIssue[] = listing.issues.map(issue => ({name: issue.path, message: issue.message}));
        for (const entry of listing.entries) {
          if (!entry.name.endsWith(".json")) continue;
          if (entry.kind !== "file") {
            nextIssues.push({name: entry.path, message: entry.kind === "symlink" ? "时间线文件不能是符号链接，已跳过。" : "时间线路径不是普通文件，已跳过。"});
            continue;
          }
          const id = idFromPath(entry.path);
          if (!id || entry.path !== `${DIRECTORY}/${entry.name}`) {
            nextIssues.push({name: entry.name, message: "文件名不是规范 UUID.json，已保留原文件。"});
            continue;
          }
          nextPaths.add(entry.path);
        }

        // Keep only paths from the latest successful directory listing. The shared storage snapshot
        // remains the sole owner of their bytes, including previously loaded bytes after a read error.
        knownPaths = nextPaths;
        for (const path of decodedByPath.keys()) if (!nextPaths.has(path)) decodedByPath.delete(path);
        issues = nextIssues;
        error = null;
        loaded = true;
        publish();

        for (const path of nextPaths) {
          if (!alive || requestGeneration !== generation) return false;
          try {
            const file = await source.read(path);
            if (!alive || requestGeneration !== generation) return false;
            if (!file) {
              issues.push({name: path, message: "文件读取失败，已保留已有内容。"});
              continue;
            }
            // Decoding is performed by the snapshot builder and cached by the canonical byte array.
          } catch (cause) {
            if (!alive || requestGeneration !== generation) return false;
            issues.push({name: path, message: cause instanceof Error ? cause.message : "文件读取失败，已保留已有内容。"});
          }
        }
        if (!alive || requestGeneration !== generation) return false;
        loading = false;
        const currentStorage = source.getSnapshot();
        error = currentStorage.blocked ? currentStorage.error : null;
        publish();
        return true;
      } catch (cause) {
        if (!alive || requestGeneration !== generation) return false;
        loading = false;
        error = cause instanceof Error ? cause.message : "读取时间线目录失败。";
        publish();
        return false;
      } finally {
        if (loadOperation === operation) loadOperation = null;
      }
    })().then(resolveOperation, () => resolveOperation(false));
    return operation;
  }

  async function create(id: string, content: string): Promise<TimelineListFile | null> {
    if (!alive || snapshot.blocked || creating || !loaded) return null;
    const path = timelinePath(id);
    creating = true;
    error = null;
    let createOperation: ReturnType<ProjectFiles["create"]>;
    try {
      // Accept the create with storage before notifying listeners, which may begin project leave.
      createOperation = source.create(path, encodeUtf8(content), {createParents: true, acceptIdentical: true});
    } catch (cause) {
      creating = false;
      error = cause instanceof Error ? cause.message : "创建时间线文件失败。";
      publish();
      return null;
    }
    publish();
    try {
      const file = await createOperation;
      if (!alive) return null;
      if (!file) {
        const current = source.getSnapshot();
        error = (current.blocked ? current.error : null) ?? "创建时间线文件失败。";
        return null;
      }
      knownPaths.add(path);
      issues = issues.filter(issue => issue.name !== path);
      try {
        const content = decodeFile(path, file.bytes);
        if (content === null) throw new Error("创建后的时间线文件不是有效 UTF-8。");
        const created = Object.freeze({id, content, saveState: file.saveState, saveError: file.saveError});
        return created;
      } catch {
        error = "创建后的时间线文件不是有效 UTF-8。";
        return null;
      }
    } catch (cause) {
      if (alive) error = cause instanceof Error ? cause.message : "创建时间线文件失败。";
      return null;
    } finally {
      if (alive) { creating = false; publish(); }
    }
  }

  async function remove(id: string): Promise<boolean> {
    if (!alive || snapshot.blocked || deletingId !== null || !knownPaths.has(timelinePath(id))) return false;
    const path = timelinePath(id);
    deletingId = id;
    error = null;
    let deleteOperation: ReturnType<ProjectFiles["delete"]>;
    try {
      // Accept the delete before a deleting-state listener can start project leave.
      deleteOperation = source.delete(path);
    } catch (cause) {
      deletingId = null;
      error = cause instanceof Error ? cause.message : "删除时间线文件失败。";
      publish();
      return false;
    }
    publish();
    try {
      const deleted = await deleteOperation;
      if (!alive) return false;
      if (!deleted) {
        const current = source.getSnapshot();
        error = (current.blocked ? current.error : null) ?? "删除时间线文件失败。";
        return false;
      }
      knownPaths.delete(path);
      decodedByPath.delete(path);
      issues = issues.filter(issue => issue.name !== path);
      return true;
    } catch (cause) {
      if (alive) error = cause instanceof Error ? cause.message : "删除时间线文件失败。";
      return false;
    } finally {
      if (alive) { deletingId = null; publish(); }
    }
  }

  async function save(id: string): Promise<boolean> {
    if (!alive || snapshot.blocked) return false;
    const saved = await source.save(timelinePath(id));
    if (alive && !saved) {
      const current = source.getSnapshot();
      const file = current.files.find(item => item.path === timelinePath(id));
      error = file?.saveError ?? (current.blocked ? current.error : null) ?? "保存时间线文件失败。";
      publish();
    }
    return saved;
  }

  return {
    getSnapshot() { return snapshot; },
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    create,
    delete: remove,
    save,
    clearError() { if (alive) { error = null; source.clearError(); publish(); } },
    dispose() {
      if (!alive) return;
      alive = false;
      generation++;
      unsubscribe();
      listeners.clear();
      decodedByPath.clear();
    },
  };
}
