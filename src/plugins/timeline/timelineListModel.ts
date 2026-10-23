import type {TimelineListFile, TimelineListFilesSnapshot} from "./timelineListFiles";
import type {TimelineCreateDraft, TimelineListEntry, TimelineListIssue, TimelineListSnapshot} from "@lodestory/sdk/timeline";

export type {TimelineCreateDraft, TimelineListEntry, TimelineListIssue, TimelineListSnapshot} from "@lodestory/sdk/timeline";

type TimelineListFailure = {kind: "load"} | {kind: "create"} | {kind: "delete"; id: string} | {kind: "save"; id: string};

type TimelineListCollection = {
  getSnapshot(): TimelineListFilesSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  create(id: string, content: string): Promise<TimelineListFile | null>;
  delete(id: string): Promise<boolean>;
  save(id: string): Promise<boolean>;
  clearError(): void;
  dispose(): void;
};

type TimelineListModelOptions = {
  createId?: () => string;
  now?: () => string;
};

const FORMAT = "lodestory.timeline-list-entry";
const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const FILE_FIELDS = ["format", "schemaVersion", "id", "title", "summary", "createdAt", "updatedAt"];

type StoredTimeline = Readonly<{
  format: typeof FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}>;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isUtcRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23 && minute <= 59 && second <= 59;
}

export function validateTimelineFile(value: unknown, fileId?: string): {entry: StoredTimeline | null; error: string | null} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {entry: null, error: "文件内容必须是对象。"};
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== FILE_FIELDS.length || keys.some((key, index) => key !== [...FILE_FIELDS].sort()[index])) {
    return {entry: null, error: "字段与时间线列表格式不匹配。"};
  }
  if (record.format !== FORMAT || record.schemaVersion !== SCHEMA_VERSION) return {entry: null, error: "时间线列表格式或版本不受支持。"};
  if (!isCanonicalUuid(record.id) || (fileId !== undefined && record.id !== fileId)) {
    return {entry: null, error: "条目编号无效或与文件名不一致。"};
  }
  if (typeof record.title !== "string" || record.title !== record.title.trim() || [...record.title].length < 1 || [...record.title].length > 60) {
    return {entry: null, error: "名称必须是 trim 后 1 到 60 个 Unicode 字符。"};
  }
  if (typeof record.summary !== "string" || [...record.summary].length > 200) {
    return {entry: null, error: "梗概不能超过 200 个 Unicode 字符。"};
  }
  if (!isUtcRfc3339(record.createdAt) || !isUtcRfc3339(record.updatedAt)) {
    return {entry: null, error: "时间戳必须是有效的 UTC RFC 3339 时间。"};
  }
  return {entry: Object.freeze({
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    id: record.id,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }), error: null};
}

function parseFile(file: TimelineListFile): {entry: TimelineListEntry | null; issue: TimelineListIssue | null} {
  if (!isCanonicalUuid(file.id)) return {entry: null, issue: {name: file.id, message: "文件名不是规范 UUID，已保留原文件。"}};
  let value: unknown;
  try { value = JSON.parse(file.content); }
  catch { return {entry: null, issue: {name: file.id, message: "JSON 内容损坏，已保留原文件。"}}; }
  const result = validateTimelineFile(value, file.id);
  if (!result.entry) return {entry: null, issue: {name: file.id, message: `${result.error} 已保留原文件。`}};
  return {entry: Object.freeze({
    ...result.entry,
    period: "",
    eventCount: 0,
    saveState: file.saveState,
    saveError: file.saveError,
  }), issue: null};
}

function compareUtcTimestamps(left: string, right: string): number {
  const leftMatch = TIMESTAMP_PATTERN.exec(left)!;
  const rightMatch = TIMESTAMP_PATTERN.exec(right)!;
  const leftWhole = left.slice(0, left.indexOf("." ) < 0 ? -1 : left.indexOf("."));
  const rightWhole = right.slice(0, right.indexOf(".") < 0 ? -1 : right.indexOf("."));
  const wholeOrder = leftWhole.localeCompare(rightWhole);
  if (wholeOrder) return wholeOrder;
  const leftFraction = leftMatch[7] ?? "";
  const rightFraction = rightMatch[7] ?? "";
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, "0").localeCompare(rightFraction.padEnd(width, "0"));
}

function sortEntries(entries: TimelineListEntry[]): TimelineListEntry[] {
  return entries.sort((left, right) => compareUtcTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id));
}

function serializeTimeline(entry: StoredTimeline): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

export function createTimelineListModel(collection: TimelineListCollection, options: TimelineListModelOptions = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<() => void>();
  let selectedId: string | null = null;
  let createDraft: TimelineCreateDraft | null = null;
  let failure: TimelineListFailure = {kind: "load"};
  let alive = true;
  let collectionSnapshot = collection.getSnapshot();
  let snapshot = buildSnapshot(collectionSnapshot);

  function buildSnapshot(source: TimelineListFilesSnapshot): TimelineListSnapshot {
    const entries: TimelineListEntry[] = [];
    const issues: TimelineListIssue[] = [...source.issues];
    for (const file of source.files) {
      const parsed = parseFile(file);
      if (parsed.entry) entries.push(parsed.entry);
      if (parsed.issue) issues.push(parsed.issue);
    }
    sortEntries(entries);
    const selected = selectedId && entries.some(entry => entry.id === selectedId) ? selectedId : null;
    if (selected !== selectedId) selectedId = selected;
    const retryDisabled = isCollectionBusy(source);
    const busy = !source.loaded || retryDisabled;
    const retryLabel = failure.kind === "create" ? "重试创建"
      : failure.kind === "delete" ? "重试删除"
        : failure.kind === "save" ? "重试保存" : "重试读取";
    return Object.freeze({
      entries: Object.freeze(entries),
      selectedId,
      createDraft,
      issues: Object.freeze(issues),
      loaded: source.loaded,
      loading: source.loading,
      creating: source.creating,
      busy,
      retryDisabled,
      error: source.error,
      retryLabel,
    });
  }

  function isCollectionBusy(source: TimelineListFilesSnapshot): boolean {
    return source.loading || source.creating || source.deletingId !== null || source.blocked
      || source.files.some(file => file.saveState === "pending" || file.saveState === "saving");
  }

  function publish(source = collection.getSnapshot()) {
    if (!alive) return;
    collectionSnapshot = source;
    snapshot = buildSnapshot(source);
    for (const listener of [...listeners]) listener();
  }

  const unsubscribe = collection.subscribe(() => publish());

  function setSelected(id: string | null) {
    if (!alive || (id !== null && !snapshot.entries.some(entry => entry.id === id)) || selectedId === id) return;
    selectedId = id;
    publish(collectionSnapshot);
  }

  function beginCreate(): TimelineCreateDraft | null {
    if (!alive || snapshot.busy) return null;
    if (!createDraft) {
      createDraft = Object.freeze({id: createId(), createdAt: now(), title: "", summary: ""});
      publish(collectionSnapshot);
    }
    return createDraft;
  }

  function updateCreateDraft(values: {title?: string; summary?: string}) {
    if (!alive || !createDraft || collectionSnapshot.creating) return;
    createDraft = Object.freeze({...createDraft, ...values});
    publish(collectionSnapshot);
  }

  function cancelCreate() {
    if (!alive || !createDraft || collectionSnapshot.creating) return;
    createDraft = null;
    if (failure.kind === "create") {
      failure = {kind: "load"};
      collection.clearError();
    }
    publish(collectionSnapshot);
  }

  async function load(): Promise<boolean> {
    if (!alive) return false;
    failure = {kind: "load"};
    try {
      const loaded = await collection.load();
      if (alive) publish();
      return loaded;
    } catch {
      if (alive) publish();
      return false;
    }
  }

  async function create(): Promise<boolean> {
    if (!alive || !createDraft || snapshot.busy) return false;
    const draft = createDraft;
    const title = draft.title.trim();
    const summary = draft.summary.trim();
    if (!isCanonicalUuid(draft.id) || !isUtcRfc3339(draft.createdAt)
      || [...title].length < 1 || [...title].length > 60 || [...summary].length > 200) return false;
    failure = {kind: "create"};
    const file: StoredTimeline = Object.freeze({
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      id: draft.id,
      title,
      summary,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    });
    try {
      const createdFile = await collection.create(draft.id, serializeTimeline(file));
      if (!alive) return false;
      if (!createdFile) { publish(); return false; }
      createDraft = null;
      publish();
      selectedId = createdFile.id;
      publish();
      return true;
    } catch {
      if (alive) publish();
      return false;
    }
  }

  async function remove(id: string): Promise<boolean> {
    if (!alive || snapshot.busy || !snapshot.entries.some(entry => entry.id === id)) return false;
    const index = snapshot.entries.findIndex(entry => entry.id === id);
    const wasSelected = selectedId === id;
    failure = {kind: "delete", id};
    try {
      const deleted = await collection.delete(id);
      if (!alive) return false;
      if (!deleted) { publish(); return false; }
      publish();
      if (wasSelected) setSelected(snapshot.entries[Math.min(index, snapshot.entries.length - 1)]?.id ?? null);
      return true;
    } catch {
      if (alive) publish();
      return false;
    }
  }

  async function save(id: string): Promise<boolean> {
    if (!alive || snapshot.busy) return false;
    failure = {kind: "save", id};
    try {
      const saved = await collection.save(id);
      if (alive) publish();
      return saved;
    } catch {
      if (alive) publish();
      return false;
    }
  }

  async function retry(): Promise<boolean> {
    if (!alive || isCollectionBusy(collection.getSnapshot())) return false;
    collection.clearError();
    if (failure.kind === "load") return load();
    if (!snapshot.loaded) return false;
    if (failure.kind === "create") return create();
    if (failure.kind === "delete") return remove(failure.id);
    if (failure.kind === "save") return save(failure.id);
    return load();
  }

  return {
    getSnapshot() { return snapshot; },
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    beginCreate,
    updateCreateDraft,
    cancelCreate,
    create,
    remove,
    save,
    retry,
    select: setSelected,
    dispose() {
      if (!alive) return;
      alive = false;
      unsubscribe();
      collection.dispose();
      listeners.clear();
    },
  };
}
