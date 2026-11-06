import type {ProjectByteView, ProjectDirectoryListing, ProjectFile, ProjectFileData, ProjectFiles} from "@lodestory/sdk/project-storage";

const PATH = ".lodestory/assets/type-order.json";
const FORMAT = "lodestory.asset-type-order";
const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AssetTypeOrderSnapshot = Readonly<{
  /** `null` means this project predates the dedicated order file. */
  typeIds: readonly string[] | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  blocked: boolean;
  error: string | null;
}>;

export type AssetTypeOrderStore = Readonly<{
  getSnapshot(): AssetTypeOrderSnapshot;
  subscribe(listener: () => void): () => void;
  load(listing?: ProjectDirectoryListing): Promise<boolean>;
  save(typeIds: readonly string[]): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): Promise<void>;
}>;

function encodeOrder(typeIds: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({format: FORMAT, schemaVersion: SCHEMA_VERSION, typeIds}, null, 2)}\n`);
}

function fileData(file: ProjectFile): ProjectFileData {
  return file.byteView ?? file.bytes;
}

function isByteView(data: ProjectFileData): data is ProjectByteView {
  return !Array.isArray(data) && !(data instanceof Uint8Array);
}

function decodeOrder(data: ProjectFileData): {typeIds: readonly string[] | null; error: string | null} {
  try {
    let bytes: Uint8Array;
    if (isByteView(data)) {
      bytes = new Uint8Array(data.byteLength);
      data.copyTo(bytes);
    } else if (data instanceof Uint8Array) bytes = data;
    else bytes = new Uint8Array(data);
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.format !== FORMAT || record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.typeIds)) throw new Error();
    if (!record.typeIds.every(id => typeof id === "string" && UUID_PATTERN.test(id))
      || new Set(record.typeIds).size !== record.typeIds.length) throw new Error();
    return {typeIds: Object.freeze([...record.typeIds]), error: null};
  } catch {
    return {typeIds: null, error: "资产模板顺序文件格式无效，原文件已保留。"};
  }
}

export function createAssetTypeOrderStore(files: ProjectFiles): AssetTypeOrderStore {
  const listeners = new Set<() => void>();
  let alive = true;
  let loaded = false;
  let readError: string | null = null;
  let writeError: string | null = null;
  let loading: Promise<boolean> | null = null;
  let creating: Promise<boolean> | null = null;
  // Before create completes (or if write is refused), there is no accepted
  // ProjectFiles buffer for the latest click. All accepted bytes belong to storage.
  let draft: {ids: readonly string[]; base: ProjectFileData | null} | null = null;
  let createBytes: Uint8Array | null = null;
  let cached: {bytes: ProjectFileData; result: ReturnType<typeof decodeOrder>} | null = null;

  function file() {
    return files.getSnapshot().files.find(item => item.path === PATH);
  }
  function buildSnapshot(): AssetTypeOrderSnapshot {
    const entry = file();
    const bytes = entry ? fileData(entry) : null;
    if (bytes && cached?.bytes !== bytes) cached = {bytes, result: decodeOrder(bytes)};
    if (!bytes) cached = null;
    const saving = creating !== null || entry?.saveState === "saving" || entry?.saveState === "pending";
    return Object.freeze({
      typeIds: draft?.ids ?? cached?.result.typeIds ?? null,
      loaded, loading: loading !== null, saving,
      dirty: draft !== null || Boolean(entry?.dirty),
      blocked: readError !== null || Boolean(cached?.result.error),
      error: readError ?? cached?.result.error ?? writeError ?? entry?.saveError ?? null,
    });
  }
  let snapshot = buildSnapshot();
  function publish() {
    if (!alive) return;
    const next = buildSnapshot();
    if (next.typeIds === snapshot.typeIds && next.loaded === snapshot.loaded && next.loading === snapshot.loading &&
      next.saving === snapshot.saving && next.dirty === snapshot.dirty && next.blocked === snapshot.blocked &&
      next.error === snapshot.error) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  const unsubscribe = files.subscribe(publish);

  function load(listing?: ProjectDirectoryListing): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loading) return loading;
    if (loaded && !snapshot.blocked) return Promise.resolve(true);
    loading = Promise.resolve().then(async () => {
      if (!alive) return false;
      const directory = listing ?? await files.list(".lodestory/assets");
      if (!alive) return false;
      if (!directory) throw new Error(files.getSnapshot().error ?? "读取资产模板顺序目录失败。");
      const issue = directory.issues.find(item => item.path === PATH || item.path === "type-order.json");
      if (issue) throw new Error(issue.message);
      const entry = directory.entries.find(item => item.name === "type-order.json" || item.path === PATH);
      if (entry) {
        if (entry.path !== PATH || entry.kind !== "file") throw new Error("资产模板顺序路径不是普通文件。");
        if (!await files.read(PATH, {preferByteView: true})) throw new Error(files.getSnapshot().error ?? "读取资产模板顺序失败。");
      }
      if (!alive) return false;
      loaded = true;
      readError = null;
      return !buildSnapshot().blocked;
    }).catch(cause => {
      readError = cause instanceof Error ? cause.message : "读取资产模板顺序失败。";
      return false;
    }).finally(() => { loading = null; publish(); });
    publish();
    return loading;
  }

  function failed(message: string): false {
    writeError = message;
    publish();
    return false;
  }
  async function flush(): Promise<boolean> {
    try {
      const saved = await files.save(PATH);
      if (!saved) return failed(file()?.saveError ?? files.getSnapshot().error ?? "保存资产模板顺序失败，请重试。");
      writeError = null;
      publish();
      return true;
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : "保存资产模板顺序失败，请重试。");
    }
  }

  // ProjectFiles serializes disk writes and persists changes accepted during a save.
  function write(ids: readonly string[], base: ProjectFileData): Promise<boolean> {
    const bytes = encodeOrder(ids);
    draft = null;
    writeError = null;
    try {
      if (files.write(PATH, bytes, {preferByteView: true})) return flush();
    } catch (cause) {
      writeError = cause instanceof Error ? cause.message : null;
    }
    draft = {ids, base};
    return Promise.resolve(failed(writeError ?? files.getSnapshot().error ?? "项目存储未接受资产模板顺序，请重试。"));
  }

  function create(ids: readonly string[]): Promise<boolean> {
    draft = {ids, base: null};
    writeError = null;
    if (creating) {
      publish();
      return creating;
    }
    // Retry with the same original bytes if the first create reached disk but its
    // acknowledgement failed. Clicks received meanwhile are applied after creation.
    const first = createBytes ??= encodeOrder(ids);
    const operation = Promise.resolve().then(async () => {
      const created = await files.create(PATH, first, {createParents: true, acceptIdentical: true, preferByteView: true});
      if (!created) return failed(files.getSnapshot().error ?? "创建资产模板顺序文件失败，请重试。");
      const current = file();
      const accepted = fileData(created);
      if (!current || fileData(current) !== accepted ||
        !(isByteView(accepted) ? accepted.equals(first) : accepted.length === first.length && accepted.every((value, i) => value === first[i]))) {
        return failed("顺序文件已发生变化，请检查文件后重试。");
      }
      const latest = draft!.ids;
      createBytes = null;
      draft = null;
      creating = null;
      // If a create is retried, compare against the actual accepted order as the
      // latest draft and the original request need not be the same.
      const writtenIds = decodeOrder(accepted).typeIds!;
      if (latest.length !== writtenIds.length || latest.some((id, i) => id !== writtenIds[i])) return write(latest, accepted);
      publish();
      return true;
    }).catch(cause => failed(cause instanceof Error ? cause.message : "创建资产模板顺序文件失败，请重试。"))
      .finally(() => { if (creating === operation) creating = null; publish(); });
    creating = operation;
    publish();
    return operation;
  }

  function save(ids: readonly string[]): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || loading) return Promise.resolve(false);
    const entry = file();
    if (creating || !entry) return create(Object.freeze([...ids]));
    return write(Object.freeze([...ids]), fileData(entry));
  }
  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (creating) return creating;
    if (loading) return loading;
    if (!loaded || snapshot.blocked) {
      if (!await load()) return false;
    }
    if (draft) {
      if (draft.base === null) return create(draft.ids);
      const entry = file();
      if (!entry || fileData(entry) !== draft.base) return failed("顺序文件已发生变化，请检查文件后重试。");
      return write(draft.ids, draft.base);
    }
    return snapshot.dirty || snapshot.saving ? flush() : true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load, save, retry,
    async dispose() {
      alive = false;
      unsubscribe();
      listeners.clear();
      if (creating) await creating;
    },
  };
}
