import type {ProjectByteView, ProjectDirectoryListing, ProjectFile, ProjectFileData, ProjectFiles} from "@lodestory/sdk/project-storage";
import type {AssetFieldDefinition, AssetRecord} from "./assetSchemaStore";

export type AssetGroupId = string | null;

export type AssetGroupData = Readonly<{
  assets: readonly AssetRecord[];
  fields: readonly AssetFieldDefinition[];
}>;

export const ASSET_OBJECTS_DIRECTORY = ".lodestory/assets/objects";
export const ASSET_TEMPLATE_FIELDS_DIRECTORY = ".lodestory/assets/templates";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GROUP_FIELDS = ["assets", "fields"];
const TEMPLATE_FIELDS = ["fields"];

type ParsedGroup = Readonly<{
  bytes: ProjectFileData;
  data: AssetGroupData;
}>;

type ParsedTemplateFields = Readonly<{
  bytes: ProjectFileData;
  fields: readonly AssetFieldDefinition[];
}>;

export const VALIDATE_AND_ENCODE_GROUP = "asset-management/validate-and-encode-group";
export type EncodeAssetGroup = (id: AssetGroupId, data: AssetGroupData) => Promise<Uint8Array>;

/** Browser implementation of the same task used by the desktop Rust executor. */
export function encodeAssetGroupFallback(input: unknown): Uint8Array {
  if (!isRecord(input) || !(input.id === null || typeof input.id === "string")) {
    throw new Error("资产对象分组 ID 必须是 UUID 或空类型。");
  }
  return encode(validateGroupData(input.id, input.data));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysMatch(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function fileData(file: ProjectFile): ProjectFileData {
  return file.byteView ?? file.bytes;
}

function isByteView(data: ProjectFileData): data is ProjectByteView {
  return !Array.isArray(data) && !(data instanceof Uint8Array);
}

function decode(data: ProjectFileData): unknown {
  let bytes: Uint8Array;
  if (isByteView(data)) {
    bytes = new Uint8Array(data.byteLength);
    data.copyTo(bytes);
  } else {
    bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
}

function validateGroupId(id: AssetGroupId): void {
  if (id !== null && !UUID_PATTERN.test(id)) throw new Error("资产对象分组 ID 必须是 UUID 或空类型。");
}

function validateTemplateId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error("资产模板 ID 必须是 UUID。");
}

function validateTemplateFields(id: string, value: unknown): readonly AssetFieldDefinition[] {
  validateTemplateId(id);
  if (!isRecord(value) || !keysMatch(value, TEMPLATE_FIELDS) || !Array.isArray(value.fields)) {
    throw new Error("资产模板字段文件格式无效，原文件已保留。");
  }

  for (const field of value.fields) {
    if (!isRecord(field) || !isRecord(field.owner) || field.owner.kind !== "type" || field.owner.id !== id) {
      throw new Error("资产模板字段不属于当前模板，原文件已保留。");
    }
  }
  return Object.freeze(value.fields as AssetFieldDefinition[]);
}

function validateGroupData(id: AssetGroupId, value: unknown): AssetGroupData {
  validateGroupId(id);
  if (!isRecord(value) || !keysMatch(value, GROUP_FIELDS) || !Array.isArray(value.assets) || !Array.isArray(value.fields)) {
    throw new Error("资产对象分组文件字段无效，原文件已保留。");
  }

  const assetIds = new Set<string>();
  for (const asset of value.assets) {
    if (!isRecord(asset) || asset.typeId !== id || typeof asset.id !== "string" || !UUID_PATTERN.test(asset.id)
      || assetIds.has(asset.id)) {
      throw new Error("资产对象不属于当前模板分组或 ID 重复，原文件已保留。");
    }
    assetIds.add(asset.id);
  }

  for (const field of value.fields) {
    if (!isRecord(field) || !isRecord(field.owner)) {
      throw new Error("资产字段所属信息无效，原文件已保留。");
    }
    if (field.owner.kind === "type") {
      throw new Error("对象文件中不能包含模板字段，原文件已保留。");
    } else if (field.owner.kind === "asset") {
      if (typeof field.owner.id !== "string" || !assetIds.has(field.owner.id)) {
        throw new Error("对象专属字段的所属对象不在当前分组，原文件已保留。");
      }
    } else {
      throw new Error("资产字段所属类型无效，原文件已保留。");
    }
  }

  return Object.freeze({
    assets: Object.freeze(value.assets as AssetRecord[]),
    fields: Object.freeze(value.fields as AssetFieldDefinition[]),
  });
}

function sameBytes(left: ProjectFileData, right: Uint8Array): boolean {
  if (isByteView(left)) return left.equals(right);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function pathFile(files: ProjectFiles, path: string): ProjectFile | undefined {
  return files.getSnapshot().files.find(file => file.path === path);
}

async function loadFiles<TId extends string | null, TData>(
  files: ProjectFiles,
  ids: readonly TId[],
  directory: string,
  pathForId: (id: TId) => string,
  parseFile: (id: TId, file: ProjectFile) => TData,
): Promise<Map<TId, TData>> {
  if (ids.length === 0) return new Map();
  const paths = new Map(ids.map(id => [id, pathForId(id)] as const));
  if (paths.size !== ids.length) throw new Error("数据文件 ID 重复。");

  let listing: ProjectDirectoryListing | null;
  try { listing = await files.list(directory); }
  catch (cause) {
    throw cause instanceof Error ? cause : new Error("读取数据文件目录失败。");
  }
  if (!listing) throw new Error(files.getSnapshot().error ?? "读取数据文件目录失败。");

  const loaded = await Promise.all([...paths].map(async ([id, path]): Promise<[TId, TData] | null> => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const matchingIssue = listing.issues.find(issue => issue.path === path || issue.path === name || issue.path === directory);
    if (matchingIssue) throw new Error(matchingIssue.message || `读取数据文件“${path}”失败。`);

    const matchingEntries = listing.entries.filter(entry => entry.path === path || entry.name === name);
    if (matchingEntries.length > 1) throw new Error(`数据文件路径“${path}”在目录中重复。`);
    const entry = matchingEntries[0];
    if (!entry) return null;
    if (entry.path !== path || entry.name !== name || entry.kind !== "file") {
      throw new Error(`数据文件路径“${path}”不是普通文件，原文件已保留。`);
    }

    let file: ProjectFile | null;
    try { file = await files.read(path, {preferByteView: true}); }
    catch (cause) {
      throw cause instanceof Error ? cause : new Error(`读取数据文件“${path}”失败，原文件已保留。`);
    }
    if (!file) throw new Error(files.getSnapshot().error ?? `读取数据文件“${path}”失败，原文件已保留。`);
    return [id, parseFile(id, file)];
  }));
  return new Map(loaded.filter((entry): entry is [TId, TData] => entry !== null));
}

type PendingWrite = Readonly<{proposed: Uint8Array}>;

async function saveBytes(
  files: ProjectFiles,
  attempts: Map<string, PendingWrite>,
  path: string,
  bytes: Uint8Array,
  existing: boolean,
  failure: string,
): Promise<void> {
  if (files.getSnapshot().blocked) throw new Error(files.getSnapshot().error ?? failure);

  if (existing) {
    const current = pathFile(files, path);
    if (!current) throw new Error(`无法更新尚未读取的文件“${path}”。`);
    const currentData = fileData(current);
    const previous = attempts.get(path);
    if (previous && !sameBytes(currentData, previous.proposed)) {
      throw new Error(`文件“${path}”在保存失败后又发生变化，请先重新加载以保护外部修改。`);
    }
    if (!files.write(path, bytes, {preferByteView: true})) {
      throw new Error(files.getSnapshot().error ?? failure);
    }
    const written = pathFile(files, path);
    if (!written || !sameBytes(fileData(written), bytes)) {
      attempts.set(path, {proposed: bytes});
      throw new Error(`文件“${path}”在保存期间收到其他修改，请重试前检查最新内容。`);
    }

    if (!await files.save(path)) {
      attempts.set(path, {proposed: bytes});
      throw new Error(pathFile(files, path)?.saveError ?? files.getSnapshot().error ?? failure);
    }
    const persisted = pathFile(files, path);
    if (!persisted || persisted.dirty || !sameBytes(fileData(persisted), bytes)) {
      attempts.set(path, {proposed: bytes});
      throw new Error(`文件“${path}”在保存期间又收到其他修改，当前修改尚未确认保存。`);
    }
    attempts.delete(path);
    return;
  }

  const created = await files.create(path, bytes, {
    createParents: true,
    acceptIdentical: true,
    preferByteView: true,
  });
  if (!created || !sameBytes(fileData(created), bytes)) {
    throw new Error(files.getSnapshot().error ?? failure);
  }
  const current = pathFile(files, path);
  if (!current || !sameBytes(fileData(current), bytes)) {
    throw new Error(`新文件“${path}”在创建期间发生变化，已保留现有内容。`);
  }
  if (!await files.save(path)) {
    throw new Error(pathFile(files, path)?.saveError ?? files.getSnapshot().error ?? failure);
  }
  const persisted = pathFile(files, path);
  if (!persisted || persisted.dirty || !sameBytes(fileData(persisted), bytes)) {
    throw new Error(`新文件“${path}”在创建期间收到其他修改，当前修改尚未确认保存。`);
  }
}

export function assetGroupPath(id: AssetGroupId): string {
  validateGroupId(id);
  return `${ASSET_OBJECTS_DIRECTORY}/${id ?? "unclassified"}.json`;
}

export function assetTemplateFieldsPath(id: string): string {
  validateTemplateId(id);
  return `${ASSET_TEMPLATE_FIELDS_DIRECTORY}/${id}.json`;
}

export function createAssetObjectFiles(files: ProjectFiles, encodeGroup: EncodeAssetGroup = async (id, data) => encodeAssetGroupFallback({id, data})) {
  const parsed = new Map<AssetGroupId, ParsedGroup>();
  const parsedTemplateFields = new Map<string, ParsedTemplateFields>();
  const attempts = new Map<string, PendingWrite>();
  let disposed = false;

  function parseFile(id: AssetGroupId, file: ProjectFile): AssetGroupData {
    const bytes = fileData(file);
    const cached = parsed.get(id);
    if (cached?.bytes === bytes) return cached.data;
    let value: unknown;
    try {
      value = decode(bytes);
    } catch {
      throw new Error(`资产对象文件“${file.path}”不是有效的 UTF-8 JSON，已保留原文件。`);
    }
    const data = validateGroupData(id, value);
    parsed.set(id, {bytes, data});
    return data;
  }

  function read(id: AssetGroupId): AssetGroupData | undefined {
    const path = assetGroupPath(id);
    const file = pathFile(files, path);
    return file ? parseFile(id, file) : undefined;
  }

  function parseTemplateFields(id: string, file: ProjectFile): readonly AssetFieldDefinition[] {
    const bytes = fileData(file);
    const cached = parsedTemplateFields.get(id);
    if (cached?.bytes === bytes) return cached.fields;
    let value: unknown;
    try {
      value = decode(bytes);
    } catch {
      throw new Error(`资产模板字段文件“${file.path}”不是有效的 UTF-8 JSON，已保留原文件。`);
    }
    const fields = validateTemplateFields(id, value);
    parsedTemplateFields.set(id, {bytes, fields});
    return fields;
  }

  function readTemplateFields(id: string): readonly AssetFieldDefinition[] | undefined {
    const path = assetTemplateFieldsPath(id);
    const file = pathFile(files, path);
    return file ? parseTemplateFields(id, file) : undefined;
  }

  return Object.freeze({
    async load(ids: readonly AssetGroupId[]): Promise<Map<AssetGroupId, AssetGroupData>> {
      return loadFiles(files, ids, ASSET_OBJECTS_DIRECTORY, assetGroupPath, parseFile);
    },

    read,

    async loadTemplateFields(ids: readonly string[]): Promise<Map<string, readonly AssetFieldDefinition[]>> {
      return loadFiles(files, ids, ASSET_TEMPLATE_FIELDS_DIRECTORY, assetTemplateFieldsPath, parseTemplateFields);
    },

    readTemplateFields,

    async saveTemplateFields(
      id: string,
      fields: readonly AssetFieldDefinition[],
      existing: boolean,
      checkCurrent?: () => void,
    ): Promise<void> {
      const path = assetTemplateFieldsPath(id);
      const validatedFields = validateTemplateFields(id, {fields});
      if (existing && !readTemplateFields(id)) throw new Error(`资产模板字段文件“${path}”尚未加载。`);
      const before = pathFile(files, path);
      const beforeBytes = before && fileData(before);
      const bytes = encode({fields: validatedFields});
      if (disposed) throw new Error("资产模板字段存储已关闭，待保存内容已保留。");
      checkCurrent?.();
      const current = pathFile(files, path);
      if (beforeBytes !== (current && fileData(current))) {
        throw new Error("当前模板的字段文件在编辑期间被修改，已保留待保存的内容。");
      }
      await saveBytes(files, attempts, path, bytes, existing, "保存资产模板字段失败，请重试。");
      const saved = pathFile(files, path);
      if (saved) parsedTemplateFields.set(id, {bytes: fileData(saved), fields: validatedFields});
    },

    async saveGroup(id: AssetGroupId, data: AssetGroupData, existing: boolean, checkCurrent?: () => void): Promise<void> {
      const path = assetGroupPath(id);
      if (existing && !read(id)) throw new Error(`资产对象分组文件“${path}”尚未加载。`);
      const before = pathFile(files, path);
      const beforeBytes = before && fileData(before);
      const bytes = await encodeGroup(id, data);
      if (disposed) throw new Error("资产对象分组已关闭，待保存内容已保留。");
      checkCurrent?.();
      const current = pathFile(files, path);
      if (beforeBytes !== (current && fileData(current))) {
        throw new Error("当前模板的对象文件在编辑期间被修改，已保留待保存的内容。");
      }
      await saveBytes(files, attempts, path, bytes, existing, "保存资产对象分组失败，请重试。");
      const saved = pathFile(files, path);
      if (saved) parsed.set(id, {bytes: fileData(saved), data: Object.freeze({
        assets: Object.freeze(data.assets), fields: Object.freeze(data.fields),
      })});
    },

    dispose(): void {
      disposed = true;
      parsed.clear();
      parsedTemplateFields.clear();
      attempts.clear();
    },
  });
}
