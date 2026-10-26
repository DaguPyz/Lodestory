import type {ProjectFile, ProjectFileBytes, ProjectFiles, ProjectSaveState} from "@lodestory/sdk/project-storage";

export type TimelineAxisSettings = Readonly<{origin: number; step: number; unit: string}>;

export type TimelineAxisSnapshot = Readonly<{
  settings: TimelineAxisSettings;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  pendingCreate: boolean;
  error: string | null;
  blocked: boolean;
  saveState: ProjectSaveState;
}>;

export type TimelineAxisStore = Readonly<{
  getSnapshot(): TimelineAxisSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  update(settings: TimelineAxisSettings): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): void;
}>;

const DIRECTORY = ".lodestory/timeline/axes";
const FORMAT = "lodestory.timeline-axis-settings";
const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_FIELDS = ["format", "schemaVersion", "id", "origin", "step", "unit"];
const MAX_ORIGIN = 1_000_000_000;
const MIN_STEP = 0.000001;
const MAX_STEP = 1_000_000_000;
const MAX_UNIT_CODE_POINTS = 20;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const DEFAULT_SETTINGS: TimelineAxisSettings = Object.freeze({origin: 0, step: 5, unit: "天"});

type StoredAxis = Readonly<{
  format: typeof FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  origin: number;
  step: number;
  unit: string;
}>;

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function axisPath(id: string): string {
  return `${DIRECTORY}/${id}.json`;
}

function encodeUtf8(value: string): ProjectFileBytes {
  return Object.freeze(Array.from(new TextEncoder().encode(value)));
}

function decodeUtf8(bytes: ProjectFileBytes): string {
  return new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(bytes));
}

function validateSettings(value: unknown): {settings: TimelineAxisSettings | null; error: string | null} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {settings: null, error: "时间轴设置必须是对象。"};
  }
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== "number" || !Number.isFinite(record.origin) || Math.abs(record.origin) > MAX_ORIGIN) {
    return {settings: null, error: `原点数值必须是有限数字，且绝对值不超过 ${MAX_ORIGIN}。`};
  }
  if (typeof record.step !== "number" || !Number.isFinite(record.step) || record.step < MIN_STEP || record.step > MAX_STEP) {
    return {settings: null, error: `刻度间隔必须是有限数字，范围为 ${MIN_STEP} 到 ${MAX_STEP}。`};
  }
  if (typeof record.unit !== "string" || record.unit.trim() !== record.unit
    || [...record.unit].length < 1 || [...record.unit].length > MAX_UNIT_CODE_POINTS || CONTROL_CHARACTERS.test(record.unit)) {
    return {settings: null, error: `单位需为 trim 后 1 到 ${MAX_UNIT_CODE_POINTS} 个字符，且不能包含控制字符。`};
  }
  return {settings: Object.freeze({origin: Object.is(record.origin, -0) ? 0 : record.origin, step: record.step, unit: record.unit}), error: null};
}

function parseStoredAxis(bytes: ProjectFileBytes, id: string): {settings: TimelineAxisSettings | null; error: string | null} {
  let text: string;
  try { text = decodeUtf8(bytes); }
  catch { return {settings: null, error: "时间轴设置不是有效 UTF-8，已保留原始文件。"}; }

  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return {settings: null, error: "时间轴设置 JSON 已损坏，已保留原始文件。"}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {settings: null, error: "时间轴设置文件内容必须是对象，已保留原始文件。"};
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...FILE_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return {settings: null, error: "时间轴设置字段与文件格式不匹配，已保留原始文件。"};
  }
  if (record.format !== FORMAT || record.schemaVersion !== SCHEMA_VERSION) {
    return {settings: null, error: "时间轴设置格式或版本不受支持，已保留原始文件。"};
  }
  if (!isCanonicalUuid(record.id) || record.id !== id) {
    return {settings: null, error: "时间轴设置编号无效或与文件名不一致，已保留原始文件。"};
  }
  const validated = validateSettings(record);
  if (!validated.settings) return {settings: null, error: `${validated.error} 已保留原始文件。`};
  return {settings: validated.settings, error: null};
}

function sameSettings(left: TimelineAxisSettings, right: TimelineAxisSettings): boolean {
  return left.origin === right.origin && left.step === right.step && left.unit === right.unit;
}

function serializeAxis(id: string, settings: TimelineAxisSettings): ProjectFileBytes {
  const file: StoredAxis = Object.freeze({format: FORMAT, schemaVersion: SCHEMA_VERSION, id, ...settings});
  return encodeUtf8(`${JSON.stringify(file, null, 2)}\n`);
}

export function createTimelineAxisStore(files: ProjectFiles, timelineId: string): TimelineAxisStore {
  const path = isCanonicalUuid(timelineId) ? axisPath(timelineId) : null;
  const listeners = new Set<() => void>();
  let settings = DEFAULT_SETTINGS;
  let loaded = false;
  let loading = false;
  let creating = false;
  let pendingCreate = false;
  let knownFile = false;
  let localBlocked = false;
  let localError: string | null = path ? null : "时间线编号不是规范 UUID，无法读取时间轴设置。";
  let alive = true;
  let generation = 0;
  let loadOperation: Promise<boolean> | null = null;
  let createOperation: Promise<boolean> | null = null;
  let retryMode: "load" | "create" | "save" | "idle" = "load";
  let parsedBytes: ProjectFileBytes | undefined;
  let hasParsedBytes = false;
  let cachedParse: ReturnType<typeof parseStoredAxis> | undefined;
  let snapshot = buildSnapshot(files.getSnapshot());

  function fileFrom(sourceFiles = files.getSnapshot().files): ProjectFile | undefined {
    return path ? sourceFiles.find(file => file.path === path) : undefined;
  }

  function buildSnapshot(source = files.getSnapshot()): TimelineAxisSnapshot {
    const file = fileFrom(source.files);
    const saveState: ProjectSaveState = creating ? "saving" : pendingCreate ? "error" : file?.saveState ?? "saved";
    return Object.freeze({
      settings,
      loaded,
      loading,
      saving: creating || saveState === "pending" || saveState === "saving",
      dirty: pendingCreate || Boolean(file?.dirty),
      pendingCreate,
      error: localError ?? file?.saveError ?? (saveState === "error" ? "时间轴设置保存失败，请重试。" : null),
      blocked: source.blocked || localBlocked,
      saveState,
    });
  }

  function parseFile(bytes: ProjectFileBytes): ReturnType<typeof parseStoredAxis> {
    if (!hasParsedBytes || bytes !== parsedBytes) {
      parsedBytes = bytes;
      hasParsedBytes = true;
      cachedParse = parseStoredAxis(bytes, timelineId);
    }
    return cachedParse!;
  }

  function sameSnapshot(left: TimelineAxisSnapshot, right: TimelineAxisSnapshot): boolean {
    return left.settings === right.settings && left.loaded === right.loaded && left.loading === right.loading
      && left.saving === right.saving && left.dirty === right.dirty && left.pendingCreate === right.pendingCreate
      && left.error === right.error && left.blocked === right.blocked && left.saveState === right.saveState;
  }

  function publish() {
    if (!alive) return;
    const next = buildSnapshot();
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  const unsubscribe = files.subscribe(() => {
    if (!alive) return;
    const sharedFile = fileFrom();
    if (sharedFile) {
      knownFile = true;
      const parsed = parseFile(sharedFile.bytes);
      if (parsed.settings) {
        if (!sameSettings(settings, parsed.settings)) settings = parsed.settings;
        pendingCreate = false;
        localBlocked = false;
      } else if (loaded) {
        localBlocked = true;
        localError = parsed.error;
      }
    } else if (knownFile) {
      knownFile = false;
    }
    publish();
  });

  async function readKnownFile(file: ProjectFile, requestGeneration: number): Promise<boolean> {
    if (!alive || requestGeneration !== generation) return false;
    const parsed = parseFile(file.bytes);
    if (!parsed.settings) {
      loaded = false;
      localBlocked = true;
      localError = parsed.error;
      retryMode = "load";
      publish();
      return false;
    }
    if (!sameSettings(settings, parsed.settings)) settings = parsed.settings;
    knownFile = true;
    pendingCreate = false;
    loaded = true;
    localBlocked = false;
    localError = null;
    retryMode = "save";
    publish();
    return true;
  }

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loaded && !localBlocked) return Promise.resolve(true);
    if (loadOperation) return loadOperation;
    if (!path) return Promise.resolve(false);

    const requestGeneration = ++generation;
    loading = true;
    localError = null;
    retryMode = "load";
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    loadOperation = operation;

    // Dirty or in-flight bytes are canonical and must never be replaced by a disk refresh. Clean bytes
    // go through list/read so a retry can observe a repaired file or an external edit.
    const sharedFile = fileFrom();
    const protectedSharedFile = sharedFile && (sharedFile.dirty || sharedFile.saveState === "pending" || sharedFile.saveState === "saving")
      ? sharedFile : undefined;
    let listingOperation: ReturnType<ProjectFiles["list"]> | null = null;
    if (!protectedSharedFile) {
      try { listingOperation = files.list(DIRECTORY); }
      catch (cause) { listingOperation = Promise.reject(cause); }
    }
    publish();

    void (async () => {
      try {
        if (protectedSharedFile) return await readKnownFile(protectedSharedFile, requestGeneration);

        let listing: Awaited<ReturnType<ProjectFiles["list"]>>;
        try { listing = await listingOperation!; }
        catch (cause) {
          if (!alive || requestGeneration !== generation) return false;
          loaded = false;
          localBlocked = true;
          localError = cause instanceof Error ? cause.message : "读取时间轴设置目录失败。";
          publish();
          return false;
        }
        if (!alive || requestGeneration !== generation) return false;
        if (!listing) {
          loaded = false;
          localBlocked = false;
          localError = files.getSnapshot().error ?? "读取时间轴设置目录失败。";
          publish();
          return false;
        }

        const name = `${timelineId}.json`;
        const entry = listing.entries.find(item => item.name === name || item.path === path);
        const matchingIssue = listing.issues.find(issue => issue.path === path || issue.path === name);
        if (matchingIssue) {
          loaded = false;
          localBlocked = true;
          localError = matchingIssue.message;
          publish();
          return false;
        }
        if (!entry) {
          settings = DEFAULT_SETTINGS;
          loaded = true;
          pendingCreate = false;
          knownFile = false;
          localBlocked = false;
          localError = null;
          retryMode = "idle";
          publish();
          return true;
        }
        if (entry.kind !== "file" || entry.path !== path) {
          loaded = false;
          localBlocked = true;
          localError = "时间轴设置路径不是普通文件，已保留原始文件。";
          publish();
          return false;
        }

        // Only read after listing has confirmed that the file exists, so a missing file cannot pollute source.error.
        let readOperation: ReturnType<ProjectFiles["read"]>;
        try { readOperation = files.read(path); }
        catch (cause) { readOperation = Promise.reject(cause); }
        let file: ProjectFile | null = null;
        let readFailure: unknown = null;
        try { file = await readOperation; }
        catch (cause) { readFailure = cause; }
        if (!alive || requestGeneration !== generation) return false;
        if (file) return await readKnownFile(file, requestGeneration);

        const retainedFile = fileFrom();
        if (retainedFile && (retainedFile.dirty || retainedFile.saveState === "saving")) {
          return await readKnownFile(retainedFile, requestGeneration);
        }
        loaded = false;
        localBlocked = false;
        localError = files.getSnapshot().error ?? (readFailure instanceof Error ? readFailure.message : "时间轴设置文件读取失败。已保留原始文件。");
        publish();
        return false;
      } catch (cause) {
        if (!alive || requestGeneration !== generation) return false;
        loaded = false;
        localBlocked = true;
        localError = cause instanceof Error ? cause.message : "读取时间轴设置失败。";
        publish();
        return false;
      } finally {
        if (alive && requestGeneration === generation) {
          loading = false;
          publish();
        }
        if (loadOperation === operation) loadOperation = null;
      }
    })().then(resolveOperation, () => resolveOperation(false));
    return operation;
  }

  async function createCurrent(): Promise<boolean> {
    if (!alive || !path || !loaded || localBlocked || files.getSnapshot().blocked) return false;
    if (createOperation) return createOperation;
    const expectedSettings = settings;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    createOperation = operation;
    pendingCreate = true;
    creating = true;
    retryMode = "create";

    let createRequest: ReturnType<ProjectFiles["create"]>;
    try {
      createRequest = files.create(path, serializeAxis(timelineId, expectedSettings), {createParents: true, acceptIdentical: true});
    } catch (cause) {
      createRequest = Promise.reject(cause);
    }
    publish();

    void (async () => {
      try {
        const created = await createRequest;
        if (!alive) return false;
        if (!created) {
          localError = files.getSnapshot().error ?? "创建时间轴设置文件失败，请重试。";
          retryMode = "create";
          return false;
        }
        const parsed = parseFile(created.bytes);
        if (!parsed.settings) {
          loaded = false;
          localBlocked = true;
          localError = parsed.error;
          retryMode = "load";
          return false;
        }
        knownFile = true;
        pendingCreate = false;
        loaded = true;
        localBlocked = false;
        localError = null;
        if (!sameSettings(settings, parsed.settings)) settings = parsed.settings;
        retryMode = "save";
        return true;
      } catch (cause) {
        if (!alive) return false;
        localError = cause instanceof Error ? cause.message : "创建时间轴设置文件失败，请重试。";
        retryMode = "create";
        return false;
      } finally {
        if (alive) {
          creating = false;
          publish();
        }
        if (createOperation === operation) createOperation = null;
      }
    })().then(resolveOperation, () => resolveOperation(false));
    return operation;
  }

  async function update(next: TimelineAxisSettings): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || creating || !path) return false;
    const validated = validateSettings(next);
    if (!validated.settings) {
      localError = validated.error;
      publish();
      return false;
    }
    if (localBlocked) return false;

    const previous = settings;
    settings = validated.settings;
    localError = null;
    publish();

    const shared = fileFrom();
    if (knownFile || shared) {
      knownFile = true;
      let accepted = false;
      try { accepted = files.write(path, serializeAxis(timelineId, settings)); }
      catch (cause) { localError = cause instanceof Error ? cause.message : "更新时间轴设置失败。"; }
      if (!accepted) {
        settings = previous;
        localError ??= files.getSnapshot().error ?? "项目存储未接受时间轴设置。";
        publish();
        return false;
      }
      retryMode = "save";
      publish();
      let saved = false;
      try { saved = await files.save(path); }
      catch (cause) { localError = cause instanceof Error ? cause.message : "保存时间轴设置失败，请重试。"; }
      if (!alive) return false;
      if (saved) localError = null;
      else localError = fileFrom()?.saveError ?? files.getSnapshot().error ?? "保存时间轴设置失败，请重试。";
      publish();
      return saved;
    }

    retryMode = "create";
    return createCurrent();
  }

  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (loading) return loadOperation ?? false;
    if (!loaded || localBlocked) return load();
    if (creating) return createOperation ?? false;
    if (!path || files.getSnapshot().blocked) return false;
    if (!knownFile && !fileFrom()) return retryMode === "create" ? createCurrent() : true;

    retryMode = "save";
    let saved = false;
    try { saved = await files.save(path); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "保存时间轴设置失败，请重试。"; }
    if (!alive) return false;
    if (saved) localError = null;
    else localError = fileFrom()?.saveError ?? files.getSnapshot().error ?? "保存时间轴设置失败，请重试。";
    publish();
    return saved;
  }

  return Object.freeze({
    getSnapshot() { return snapshot; },
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    update,
    retry,
    dispose() {
      if (!alive) return;
      alive = false;
      generation++;
      unsubscribe();
      listeners.clear();
      parsedBytes = undefined;
      hasParsedBytes = false;
      cachedParse = undefined;
      loading = false;
      creating = false;
      snapshot = Object.freeze({...snapshot, loading: false, saving: false, blocked: true});
    },
  });
}
