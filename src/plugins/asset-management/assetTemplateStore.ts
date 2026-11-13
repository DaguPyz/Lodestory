import type {ProjectByteView, ProjectFile, ProjectFileData, ProjectFiles} from "@lodestory/sdk/project-storage";
import type {AssetTypeTemplate} from "./assetSchemaStore";

const PATH = ".lodestory/assets/templates.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_NAME_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 200;
const INVALID_LIST_ERROR = "资产模板列表格式无效，原文件已保留。";
const MISSING_LIST_ERROR = "资产模板列表文件 templates.json 缺失，请恢复文件后重试。";

export type AssetTemplateStoreSnapshot = Readonly<{
  /** `null` means the dedicated list file has not been created yet. */
  templates: readonly AssetTypeTemplate[] | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  blocked: boolean;
  error: string | null;
}>;

export type AssetTemplateStore = Readonly<{
  getSnapshot(): AssetTemplateStoreSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  save(templates: readonly AssetTypeTemplate[]): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isByteView(data: ProjectFileData): data is ProjectByteView {
  return !Array.isArray(data) && !(data instanceof Uint8Array);
}

function fileData(file: ProjectFile): ProjectFileData {
  return file.byteView ?? file.bytes;
}

function copyBytes(data: ProjectFileData): Uint8Array {
  if (isByteView(data)) {
    const bytes = new Uint8Array(data.byteLength);
    data.copyTo(bytes);
    return bytes;
  }
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function sameBytes(left: ProjectFileData, right: ProjectFileData): boolean {
  if (left === right) return true;
  if (isByteView(left)) return left.equals(right);
  if (isByteView(right)) return right.equals(left);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function encodeTemplates(templates: readonly AssetTypeTemplate[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(templates, null, 2)}\n`);
}

/** Validate and freeze a complete template list, preserving schema validation errors. */
export function validateAssetTemplates(value: unknown): {templates: readonly AssetTypeTemplate[] | null; error: string | null} {
  if (!Array.isArray(value)) return {templates: null, error: "资产模板列表必须是数组，已保留原始文件。"};
  const templates: AssetTypeTemplate[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  const activeNames = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) return {templates: null, error: "资产类型定义字段不完整或包含未知字段，已保留原始文件。"};
    const keys = Object.keys(candidate).sort();
    const required = ["description", "id", "name", "order", "status"];
    if (!required.every(key => hasOwn(candidate, key)) || keys.some(key => !required.includes(key) && key !== "color")) {
      return {templates: null, error: "资产类型定义字段不完整或包含未知字段，已保留原始文件。"};
    }
    if (typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)
      || typeof candidate.order !== "number" || !Number.isSafeInteger(candidate.order) || candidate.order < 0) {
      return {templates: null, error: "资产类型 ID 必须是 UUID，顺序必须是非负整数，已保留原始文件。"};
    }
    if (ids.has(candidate.id)) return {templates: null, error: "资产类型 ID 重复，已保留原始文件。"};
    if (orders.has(candidate.order)) return {templates: null, error: "资产类型顺序重复，已保留原始文件。"};
    if (typeof candidate.name !== "string" || [...candidate.name.trim()].length < 1 || [...candidate.name.trim()].length > MAX_NAME_LENGTH) {
      return {templates: null, error: `资产类型名称需为 trim 后 1 到 ${MAX_NAME_LENGTH} 个字符，已保留原始文件。`};
    }
    if (typeof candidate.description !== "string" || [...candidate.description].length > MAX_DESCRIPTION_LENGTH) {
      return {templates: null, error: `资产类型说明必须是文本且最多 ${MAX_DESCRIPTION_LENGTH} 个字符，已保留原始文件。`};
    }
    if (candidate.status !== "active" && candidate.status !== "archived") {
      return {templates: null, error: "资产类型状态无效，已保留原始文件。"};
    }
    const name = candidate.name.trim();
    const nameKey = name.toLowerCase();
    if (candidate.status === "active" && activeNames.has(nameKey)) {
      return {templates: null, error: "启用中的资产类型名称重复，已保留原始文件。"};
    }
    let color: string | undefined;
    if (hasOwn(candidate, "color")) {
      if (typeof candidate.color !== "string" || !COLOR_PATTERN.test(candidate.color)) {
        return {templates: null, error: "资产模板颜色必须是 #RRGGBB 格式，已保留原始文件。"};
      }
      color = candidate.color.toLowerCase();
    }
    ids.add(candidate.id);
    orders.add(candidate.order);
    if (candidate.status === "active") activeNames.add(nameKey);
    templates.push(Object.freeze({
      id: candidate.id,
      name,
      description: candidate.description,
      ...(color !== undefined ? {color} : {}),
      order: candidate.order,
      status: candidate.status,
    }));
  }
  templates.sort((left, right) => left.order - right.order);
  return {templates: Object.freeze(templates), error: null};
}

export function parseAssetTemplateList(data: ProjectFileData): {templates: readonly AssetTypeTemplate[] | null; error: string | null} {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(copyBytes(data)));
    const result = validateAssetTemplates(value);
    return result.templates ? result : {templates: null, error: result.error ?? INVALID_LIST_ERROR};
  } catch {
    return {templates: null, error: INVALID_LIST_ERROR};
  }
}

export function createAssetTemplateStore(files: ProjectFiles): AssetTemplateStore {
  const listeners = new Set<() => void>();
  let alive = true;
  let loaded = false;
  let everHadTemplateFile = Boolean(files.getSnapshot().files.some(item => item.path === PATH));
  let missingFile = false;
  let readError: string | null = null;
  let writeError: string | null = null;
  let loading: Promise<boolean> | null = null;
  let creating: Promise<boolean> | null = null;
  let draft: {templates: readonly AssetTypeTemplate[]; base: ProjectFileData | null} | null = null;
  let createBytes: Uint8Array | null = null;
  let lastKnownTemplates: readonly AssetTypeTemplate[] | null = null;
  let cached: {bytes: ProjectFileData; result: ReturnType<typeof parseAssetTemplateList>} | null = null;

  function file(): ProjectFile | undefined {
    return files.getSnapshot().files.find(item => item.path === PATH);
  }

  function buildSnapshot(): AssetTemplateStoreSnapshot {
    const entry = file();
    const bytes = entry ? fileData(entry) : null;
    if (bytes && cached?.bytes !== bytes) cached = {bytes, result: parseAssetTemplateList(bytes)};
    if (!bytes) cached = null;
    if (entry) everHadTemplateFile = true;
    if (cached?.result.templates) lastKnownTemplates = cached.result.templates;
    return Object.freeze({
      templates: draft?.templates ?? cached?.result.templates ?? lastKnownTemplates,
      loaded,
      loading: loading !== null,
      saving: creating !== null || entry?.saveState === "saving" || entry?.saveState === "pending",
      dirty: draft !== null || Boolean(entry?.dirty),
      blocked: missingFile || readError !== null || Boolean(cached?.result.error),
      error: missingFile ? MISSING_LIST_ERROR : readError ?? cached?.result.error ?? writeError ?? entry?.saveError ?? null,
    });
  }

  let snapshot = buildSnapshot();
  function publish(): void {
    if (!alive) return;
    const next = buildSnapshot();
    if (next.templates === snapshot.templates && next.loaded === snapshot.loaded && next.loading === snapshot.loading
      && next.saving === snapshot.saving && next.dirty === snapshot.dirty && next.blocked === snapshot.blocked
      && next.error === snapshot.error) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  const unsubscribe = files.subscribe(() => {
    if (file()) {
      everHadTemplateFile = true;
      missingFile = false;
    } else if (everHadTemplateFile) {
      missingFile = true;
    }
    publish();
  });

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loading) return loading;
    loading = Promise.resolve().then(async () => {
      if (!alive) return false;
      const directory = await files.list(".lodestory/assets");
      if (!alive) return false;
      if (!directory) throw new Error(files.getSnapshot().error ?? "读取资产模板列表目录失败。");
      const issue = directory.issues.find(item => item.path === PATH || item.path === "templates.json");
      if (issue) throw new Error(issue.message);
      if (!directory.exists) {
        loaded = true;
        readError = null;
        missingFile = everHadTemplateFile;
        return !missingFile;
      }
      const entry = directory.entries.find(item => item.name === "templates.json" || item.path === PATH);
      if (entry) {
        if (entry.path !== PATH || entry.kind !== "file") throw new Error("资产模板列表路径不是普通文件。");
        everHadTemplateFile = true;
        missingFile = false;
        if (!await files.read(PATH, {preferByteView: true})) throw new Error(files.getSnapshot().error ?? "读取资产模板列表失败。");
      } else if (everHadTemplateFile) {
        loaded = true;
        missingFile = true;
        readError = null;
        return false;
      }
      if (!alive) return false;
      loaded = true;
      readError = null;
      return !buildSnapshot().blocked;
    }).catch(cause => {
      readError = cause instanceof Error ? cause.message : "读取资产模板列表失败。";
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
      if (!saved) return failed(file()?.saveError ?? files.getSnapshot().error ?? "保存资产模板列表失败，请重试。");
      writeError = null;
      publish();
      return true;
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : "保存资产模板列表失败，请重试。");
    }
  }

  function write(templates: readonly AssetTypeTemplate[], base: ProjectFileData): Promise<boolean> {
    const bytes = encodeTemplates(templates);
    draft = null;
    writeError = null;
    try {
      if (files.write(PATH, bytes, {preferByteView: true})) return flush();
    } catch (cause) {
      writeError = cause instanceof Error ? cause.message : null;
    }
    draft = {templates, base};
    return Promise.resolve(failed(writeError ?? files.getSnapshot().error ?? "项目存储未接受资产模板列表，请重试。"));
  }

  function create(templates: readonly AssetTypeTemplate[]): Promise<boolean> {
    draft = {templates, base: null};
    writeError = null;
    if (creating) {
      publish();
      return creating;
    }
    const first = createBytes ??= encodeTemplates(templates);
    const operation = Promise.resolve().then(async () => {
      const created = await files.create(PATH, first, {createParents: true, acceptIdentical: true, preferByteView: true});
      if (!created) return failed(files.getSnapshot().error ?? "创建资产模板列表失败，请重试。");
      const current = file();
      const accepted = fileData(created);
      if (!current || !sameBytes(fileData(current), accepted) || !sameBytes(accepted, first)) {
        return failed("资产模板列表文件已发生变化，请检查文件后重试。");
      }
      const latest = draft!.templates;
      createBytes = null;
      draft = null;
      creating = null;
      const acceptedTemplates = parseAssetTemplateList(accepted).templates!;
      if (latest.length !== acceptedTemplates.length || latest.some((item, index) => JSON.stringify(item) !== JSON.stringify(acceptedTemplates[index]))) {
        return write(latest, accepted);
      }
      publish();
      return true;
    }).catch(cause => failed(cause instanceof Error ? cause.message : "创建资产模板列表失败，请重试。"))
      .finally(() => { if (creating === operation) creating = null; publish(); });
    creating = operation;
    publish();
    return operation;
  }

  function save(value: readonly AssetTypeTemplate[]): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || loading) return Promise.resolve(false);
    const validation = validateAssetTemplates(value);
    const templates = validation.templates;
    if (!templates) return Promise.resolve(failed(validation.error ?? INVALID_LIST_ERROR));
    const entry = file();
    if (creating || draft?.base === null) return create(templates);
    if (draft && (!entry || fileData(entry) !== draft.base)) {
      return Promise.resolve(failed("资产模板列表文件已发生变化，请检查文件后重试。"));
    }
    if (!entry) return create(templates);
    return write(templates, fileData(entry));
  }

  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (creating) return creating;
    if (loading) return loading;
    if (!loaded || snapshot.blocked) {
      if (!await load()) return false;
    }
    if (draft) {
      if (draft.base === null) return create(draft.templates);
      const entry = file();
      if (!entry || fileData(entry) !== draft.base) return failed("资产模板列表文件已发生变化，请检查文件后重试。");
      return write(draft.templates, draft.base);
    }
    return snapshot.dirty || snapshot.saving ? flush() : true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    save,
    retry,
    async dispose() {
      alive = false;
      unsubscribe();
      listeners.clear();
      if (creating) await creating;
    },
  };
}
