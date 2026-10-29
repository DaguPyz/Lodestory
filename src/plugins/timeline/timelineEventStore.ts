import type {ProjectFile, ProjectFileBytes, ProjectFiles, ProjectSaveState} from "@lodestory/sdk/project-storage";

export type TimelineEvent = Readonly<{
  id: string;
  title: string;
  summary: string;
  /** Asset IDs are owned by asset management and remain opaque here. */
  assetIds: readonly string[];
  /** Signed distance from the story origin, in the axis unit. */
  offset: number;
  placement: "above" | "below";
  important: boolean;
  /** Author-selected content color, independent of the UI theme. */
  color?: string;
}>;

export type TimelineEventSnapshot = Readonly<{
  events: readonly TimelineEvent[];
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  pendingCreate: boolean;
  error: string | null;
  blocked: boolean;
  saveState: ProjectSaveState;
}>;

export type TimelineEventStore = Readonly<{
  getSnapshot(): TimelineEventSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  upsert(event: TimelineEvent): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): void;
}>;

const DIRECTORY = ".lodestory/timeline/events";
const FORMAT = "lodestory.timeline-events";
const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMELINE_FIELDS = ["events", "format", "schemaVersion", "timelineId"];
const EVENT_FIELDS = ["assetIds", "id", "important", "offset", "placement", "summary", "title"];
const LEGACY_EVENT_FIELDS = ["id", "important", "offset", "placement", "summary", "title"];
const MAX_OFFSET = 1_000_000_000;
const MAX_TITLE = 60;
const MAX_SUMMARY = 200;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isTimelineEventColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function timelinePath(id: string): string {
  return `${DIRECTORY}/${id}.json`;
}

function encodeUtf8(value: string): ProjectFileBytes {
  return Object.freeze(Array.from(new TextEncoder().encode(value)));
}

function decodeUtf8(bytes: ProjectFileBytes): string {
  return new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(bytes));
}

function keysMatch(value: Record<string, unknown>, expectedFields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeEvent(value: unknown, allowLegacyAssetIds = false): {event: TimelineEvent | null; error: string | null} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {event: null, error: "时间线事件必须是对象。"};
  }
  const record = value as Record<string, unknown>;
  const {color, ...baseFields} = record;
  const fieldsMatch = allowLegacyAssetIds
    ? keysMatch(baseFields, LEGACY_EVENT_FIELDS) || keysMatch(baseFields, EVENT_FIELDS)
    : keysMatch(baseFields, EVENT_FIELDS);
  if (!fieldsMatch) return {event: null, error: "时间线事件字段不完整或包含未知字段。"};
  if (color !== undefined && !isTimelineEventColor(color)) return {event: null, error: "事件颜色必须是 #RRGGBB 格式。"};
  if (!isUuid(record.id)) return {event: null, error: "事件编号必须是规范 UUID。"};
  if (typeof record.title !== "string") return {event: null, error: "事件标题必须是文本。"};
  const title = record.title.trim();
  if ([...title].length < 1 || [...title].length > MAX_TITLE) {
    return {event: null, error: `事件标题需为 trim 后 1 到 ${MAX_TITLE} 个字符。`};
  }
  if (typeof record.summary !== "string" || [...record.summary].length > MAX_SUMMARY) {
    return {event: null, error: `事件摘要最多为 ${MAX_SUMMARY} 个字符。`};
  }
  if (typeof record.offset !== "number" || !Number.isFinite(record.offset) || Math.abs(record.offset) > MAX_OFFSET) {
    return {event: null, error: `事件位置必须是有限数字，且绝对值不超过 ${MAX_OFFSET}。`};
  }
  if (record.placement !== "above" && record.placement !== "below") {
    return {event: null, error: "事件位置只能是 above 或 below。"};
  }
  if (typeof record.important !== "boolean") return {event: null, error: "关键事件标记必须是布尔值。"};
  const assetIds = record.assetIds === undefined && allowLegacyAssetIds ? [] : record.assetIds;
  if (!Array.isArray(assetIds) || assetIds.some(id => !isUuid(id)) || new Set(assetIds).size !== assetIds.length) {
    return {event: null, error: "关联资产编号必须是无重复的规范 UUID。"};
  }
  return {
    event: Object.freeze({
      id: record.id,
      title,
      summary: record.summary,
      assetIds: Object.freeze([...assetIds]),
      offset: Object.is(record.offset, -0) ? 0 : record.offset,
      placement: record.placement,
      important: record.important,
      ...(color === undefined ? {} : {color: color.toLowerCase()}),
    }),
    error: null,
  };
}

function parseEvents(bytes: ProjectFileBytes, timelineId: string): {events: readonly TimelineEvent[] | null; error: string | null} {
  let text: string;
  try { text = decodeUtf8(bytes); }
  catch { return {events: null, error: "时间线事件文件不是有效 UTF-8，已保留原始文件。"}; }

  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return {events: null, error: "时间线事件 JSON 已损坏，已保留原始文件。"}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {events: null, error: "时间线事件文件内容必须是对象，已保留原始文件。"};
  }

  const record = value as Record<string, unknown>;
  if (!keysMatch(record, TIMELINE_FIELDS)) return {events: null, error: "时间线事件文件字段与格式不匹配，已保留原始文件。"};
  if (record.format !== FORMAT || record.schemaVersion !== LEGACY_SCHEMA_VERSION && record.schemaVersion !== SCHEMA_VERSION) {
    return {events: null, error: "时间线事件文件格式或版本不受支持，已保留原始文件。"};
  }
  if (!isUuid(record.timelineId) || record.timelineId !== timelineId) {
    return {events: null, error: "时间线事件文件编号无效或与路径不一致，已保留原始文件。"};
  }
  if (!Array.isArray(record.events)) return {events: null, error: "时间线事件列表必须是数组，已保留原始文件。"};

  const events: TimelineEvent[] = [];
  const ids = new Set<string>();
  for (const candidate of record.events) {
    const normalized = normalizeEvent(candidate, record.schemaVersion === LEGACY_SCHEMA_VERSION);
    if (!normalized.event) return {events: null, error: `${normalized.error} 已保留原始文件。`};
    if (ids.has(normalized.event.id)) return {events: null, error: "时间线事件编号重复，已保留原始文件。"};
    ids.add(normalized.event.id);
    events.push(normalized.event);
  }
  return {events: Object.freeze(events), error: null};
}

function serializeEvents(timelineId: string, events: readonly TimelineEvent[]): ProjectFileBytes {
  return encodeUtf8(`${JSON.stringify({format: FORMAT, schemaVersion: SCHEMA_VERSION, timelineId, events}, null, 2)}\n`);
}

function sameEvents(left: readonly TimelineEvent[], right: readonly TimelineEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return event.id === other.id && event.title === other.title && event.summary === other.summary
      && event.offset === other.offset && event.placement === other.placement && event.important === other.important && event.color === other.color
      && event.assetIds.length === other.assetIds.length && event.assetIds.every((id, assetIndex) => id === other.assetIds[assetIndex]);
  });
}

export function createTimelineEventStore(files: ProjectFiles, timelineId: string): TimelineEventStore {
  const path = isUuid(timelineId) ? timelinePath(timelineId) : null;
  const listeners = new Set<() => void>();
  let events: readonly TimelineEvent[] = Object.freeze([]);
  let loaded = false;
  let loading = false;
  let mutating = false;
  let pendingCreate = false;
  let pendingWrite = false;
  let knownFile = false;
  let localDraft = false;
  let localBlocked = false;
  let localError: string | null = path ? null : "时间线编号不是规范 UUID，无法读取时间线事件。";
  let alive = true;
  let generation = 0;
  let loadOperation: Promise<boolean> | null = null;
  let mutationOperation: Promise<boolean> | null = null;
  let parsedBytes: ProjectFileBytes | undefined;
  let hasParsedBytes = false;
  let cachedParse: ReturnType<typeof parseEvents> | undefined;
  let comparedParsedEvents: readonly TimelineEvent[] | undefined;
  let comparedCurrentEvents: readonly TimelineEvent[] | undefined;
  let snapshot = buildSnapshot(files.getSnapshot());

  function fileFrom(sourceFiles = files.getSnapshot().files): ProjectFile | undefined {
    return path ? sourceFiles.find(file => file.path === path) : undefined;
  }

  function buildSnapshot(source = files.getSnapshot()): TimelineEventSnapshot {
    const file = fileFrom(source.files);
    const saveState: ProjectSaveState = mutating ? "saving"
      : pendingCreate || pendingWrite ? (localError ? "error" : "pending")
        : file?.saveState ?? "saved";
    return Object.freeze({
      events,
      loaded,
      loading,
      saving: loading || mutating || saveState === "pending" || saveState === "saving",
      dirty: localDraft || pendingCreate || pendingWrite || Boolean(file?.dirty),
      pendingCreate,
      error: localError ?? file?.saveError ?? (saveState === "error" ? "时间线事件保存失败，请重试。" : null),
      blocked: source.blocked || localBlocked,
      saveState,
    });
  }

  function parseFile(bytes: ProjectFileBytes): ReturnType<typeof parseEvents> {
    if (!hasParsedBytes || bytes !== parsedBytes) {
      comparedParsedEvents = undefined;
      comparedCurrentEvents = undefined;
      parsedBytes = bytes;
      hasParsedBytes = true;
      cachedParse = parseEvents(bytes, timelineId);
    }
    return cachedParse!;
  }

  function applyParsedEvents(parsedEvents: readonly TimelineEvent[]) {
    if (events === parsedEvents) return;
    if (comparedParsedEvents === parsedEvents && comparedCurrentEvents === events) return;
    const unchanged = sameEvents(events, parsedEvents);
    comparedParsedEvents = parsedEvents;
    comparedCurrentEvents = events;
    if (!unchanged) {
      events = parsedEvents;
      comparedParsedEvents = undefined;
      comparedCurrentEvents = undefined;
    }
  }

  function sameSnapshot(left: TimelineEventSnapshot, right: TimelineEventSnapshot): boolean {
    return left.events === right.events && left.loaded === right.loaded && left.loading === right.loading
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

  function acceptFile(file: ProjectFile, requestGeneration?: number): boolean {
    if (!alive || requestGeneration !== undefined && requestGeneration !== generation) return false;
    const parsed = parseFile(file.bytes);
    if (!parsed.events) {
      loaded = false;
      localBlocked = true;
      localError = parsed.error;
      return false;
    }
    applyParsedEvents(parsed.events);
    knownFile = true;
    pendingCreate = false;
    pendingWrite = false;
    localDraft = false;
    loaded = true;
    localBlocked = false;
    localError = null;
    return true;
  }

  const unsubscribe = files.subscribe(() => {
    if (!alive) return;
    const sharedFile = fileFrom();
    if (sharedFile) {
      knownFile = true;
      // A mutation not yet accepted by the shared byte store is authoritative locally. In particular,
      // do not let another notification replace a failed first-create draft with an older snapshot.
      if (!localDraft) {
        const parsed = parseFile(sharedFile.bytes);
        if (parsed.events) {
          applyParsedEvents(parsed.events);
          pendingCreate = false;
          pendingWrite = false;
          localBlocked = false;
          localError = null;
        } else if (loaded) {
          localBlocked = true;
          localError = parsed.error;
        }
      }
    } else if (knownFile && !pendingCreate && !localDraft) {
      knownFile = false;
    }
    publish();
  });

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loaded && !localBlocked) return Promise.resolve(true);
    if (loadOperation) return loadOperation;
    if (!path) return Promise.resolve(false);

    const requestGeneration = ++generation;
    loading = true;
    localError = null;
    localBlocked = false;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    loadOperation = operation;

    // Dirty shared bytes are canonical. Listing first also confirms absence without leaving a failed
    // read in ProjectFiles' global error field.
    const existing = fileFrom();
    const protectedFile = existing && (existing.dirty || existing.saveState === "pending" || existing.saveState === "saving")
      ? existing : undefined;
    let listingOperation: ReturnType<ProjectFiles["list"]> | null = null;
    if (!protectedFile) {
      try { listingOperation = files.list(DIRECTORY); }
      catch (cause) { listingOperation = Promise.reject(cause); }
    }
    publish();

    void (async () => {
      try {
        if (protectedFile) {
          const valid = acceptFile(protectedFile, requestGeneration);
          publish();
          return valid;
        }

        let listing: Awaited<ReturnType<ProjectFiles["list"]>>;
        try { listing = await listingOperation!; }
        catch (cause) {
          if (!alive || requestGeneration !== generation) return false;
          loaded = false;
          localError = cause instanceof Error ? cause.message : "读取时间线事件目录失败。";
          publish();
          return false;
        }
        if (!alive || requestGeneration !== generation) return false;
        if (!listing) {
          loaded = false;
          localError = (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "读取时间线事件目录失败。";
          publish();
          return false;
        }

        const name = `${timelineId}.json`;
        const entry = listing.entries.find(candidate => candidate.name === name || candidate.path === path);
        const issue = listing.issues.find(candidate => candidate.path === path || candidate.path === name);
        if (issue) {
          loaded = false;
          localBlocked = true;
          localError = issue.message;
          publish();
          return false;
        }
        if (!entry) {
          events = Object.freeze([]);
          loaded = true;
          knownFile = false;
          pendingCreate = false;
          pendingWrite = false;
          localDraft = false;
          localBlocked = false;
          localError = null;
          publish();
          return true;
        }
        if (entry.kind !== "file" || entry.path !== path) {
          loaded = false;
          localBlocked = true;
          localError = "时间线事件路径不是普通文件，已保留原始文件。";
          publish();
          return false;
        }

        let readOperation: ReturnType<ProjectFiles["read"]>;
        try { readOperation = files.read(path); }
        catch (cause) { readOperation = Promise.reject(cause); }
        let file: ProjectFile | null = null;
        let readFailure: unknown = null;
        try { file = await readOperation; }
        catch (cause) { readFailure = cause; }
        if (!alive || requestGeneration !== generation) return false;
        if (file) {
          const valid = acceptFile(file, requestGeneration);
          publish();
          return valid;
        }

        const retainedFile = fileFrom();
        if (retainedFile && (retainedFile.dirty || retainedFile.saveState === "saving")) {
          const valid = acceptFile(retainedFile, requestGeneration);
          publish();
          return valid;
        }
        loaded = false;
        localError = (files.getSnapshot().blocked ? files.getSnapshot().error : null)
          ?? (readFailure instanceof Error ? readFailure.message : "时间线事件文件读取失败。已保留原始文件。");
        publish();
        return false;
      } catch (cause) {
        if (!alive || requestGeneration !== generation) return false;
        loaded = false;
        localBlocked = true;
        localError = cause instanceof Error ? cause.message : "读取时间线事件失败。";
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

  async function persistCurrent(): Promise<boolean> {
    if (!alive || !path || files.getSnapshot().blocked || localBlocked) return false;
    if (!knownFile && !fileFrom()) {
      if (events.length === 0) {
        pendingCreate = false;
        pendingWrite = false;
        localDraft = false;
        localError = null;
        publish();
        return true;
      }
      pendingCreate = true;
      pendingWrite = false;
      const expectedBytes = serializeEvents(timelineId, events);
      let created: ProjectFile | null = null;
      try { created = await files.create(path, expectedBytes, {createParents: true, acceptIdentical: true}); }
      catch (cause) { localError = cause instanceof Error ? cause.message : "创建时间线事件文件失败，请重试。"; }
      if (!alive) return false;
      if (!created) {
        localError ??= files.getSnapshot().error ?? "创建时间线事件文件失败，请重试。";
        return false;
      }
      const valid = acceptFile(created);
      if (!valid) return false;
      return true;
    }

    pendingCreate = false;
    pendingWrite = true;
    localDraft = true;
    const expectedBytes = serializeEvents(timelineId, events);
    let accepted = false;
    try { accepted = files.write(path, expectedBytes); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "更新时间线事件失败。"; }
    if (!accepted) {
      localError ??= (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "项目存储未接受时间线事件。";
      return false;
    }

    pendingWrite = false;
    localDraft = false;
    publish();
    let saved = false;
    try { saved = await files.save(path); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "保存时间线事件失败，请重试。"; }
    if (!alive) return false;
    localError = saved ? null : fileFrom()?.saveError ?? (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "保存时间线事件失败，请重试。";
    return saved;
  }

  function mutate(nextEvents: readonly TimelineEvent[]): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating || !path) return Promise.resolve(false);
    events = Object.freeze([...nextEvents]);
    comparedParsedEvents = undefined;
    comparedCurrentEvents = undefined;
    localDraft = true;
    pendingCreate = !knownFile && !fileFrom();
    pendingWrite = false;
    localError = null;
    mutating = true;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    mutationOperation = operation;
    publish();
    void persistCurrent().catch(cause => {
      if (alive) localError = cause instanceof Error ? cause.message : "保存时间线事件失败，请重试。";
      return false;
    }).then(result => {
      if (alive) {
        mutating = false;
        publish();
      }
      if (mutationOperation === operation) mutationOperation = null;
      resolveOperation(Boolean(result));
    });
    return operation;
  }

  function upsert(event: TimelineEvent): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating || !path) return Promise.resolve(false);
    const normalized = normalizeEvent(event);
    if (!normalized.event) {
      localError = normalized.error;
      publish();
      return Promise.resolve(false);
    }
    const index = events.findIndex(candidate => candidate.id === normalized.event!.id);
    const next = [...events];
    if (index < 0) next.push(normalized.event);
    else next[index] = normalized.event;
    return mutate(next);
  }

  function remove(id: string): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating || !path) return Promise.resolve(false);
    if (!isUuid(id)) {
      localError = "事件编号必须是规范 UUID。";
      publish();
      return Promise.resolve(false);
    }
    if (!events.some(event => event.id === id)) return Promise.resolve(false);
    return mutate(events.filter(event => event.id !== id));
  }

  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (loading) return loadOperation ?? false;
    if (mutating) return mutationOperation ?? false;
    if (!loaded || localBlocked) return load();
    if (!path || files.getSnapshot().blocked) return false;
    if (pendingCreate || pendingWrite || localDraft) {
      mutating = true;
      pendingCreate = pendingCreate || (!knownFile && events.length > 0);
      localError = null;
      let resolveOperation!: (value: boolean) => void;
      const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
      mutationOperation = operation;
      publish();
      void persistCurrent().catch(cause => {
        if (alive) localError = cause instanceof Error ? cause.message : "保存时间线事件失败，请重试。";
        return false;
      }).then(result => {
        if (alive) {
          mutating = false;
          publish();
        }
        if (mutationOperation === operation) mutationOperation = null;
        resolveOperation(Boolean(result));
      });
      return operation;
    }
    const file = fileFrom();
    if (!file?.dirty && file?.saveState !== "pending" && file?.saveState !== "saving" && file?.saveState !== "error") return true;
    let saved = false;
    try { saved = await files.save(path); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "保存时间线事件失败，请重试。"; }
    if (!alive) return false;
    localError = saved ? null : fileFrom()?.saveError ?? (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "保存时间线事件失败，请重试。";
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
    upsert,
    remove,
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
      comparedParsedEvents = undefined;
      comparedCurrentEvents = undefined;
      loading = false;
      mutating = false;
      snapshot = Object.freeze({...snapshot, loading: false, saving: false, blocked: true});
    },
  });
}
