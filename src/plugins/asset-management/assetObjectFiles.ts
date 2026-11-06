import type {ProjectByteView, ProjectFile, ProjectFileData, ProjectFiles} from "@lodestory/sdk/project-storage";
import type {AssetFieldDefinition, AssetRecord} from "./assetSchemaStore";

export type AssetGroupId = string | null;

export type AssetGroupData = Readonly<{
  assets: readonly AssetRecord[];
  fields: readonly AssetFieldDefinition[];
}>;

const DIRECTORY = ".lodestory/assets/objects";
const MANIFEST_PATH = ".lodestory/assets/schema.json";
const FORMAT = "lodestory.asset-schema";
const SCHEMA_VERSION = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GROUP_FIELDS = ["assets", "fields"];
const MANIFEST_FIELDS = ["format", "groups", "schemaVersion"];

type ParsedGroup = Readonly<{
  bytes: ProjectFileData;
  data: AssetGroupData;
}>;

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
      if (id === null || field.owner.id !== id) {
        throw new Error("模板字段不属于当前对象分组，原文件已保留。");
      }
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

/** Parse the v4 compact manifest; legacy inline schemas return null for migration. */
export function parseGroupManifest(value: unknown): readonly AssetGroupId[] | null {
  if (!isRecord(value)) throw new Error("资产对象分组清单格式无效，原文件已保留。");

  const version = value.schemaVersion;
  if (version === 1 || version === 2 || version === 3) return null;
  if (version !== SCHEMA_VERSION || value.format !== FORMAT
    || !keysMatch(value, MANIFEST_FIELDS) || !Array.isArray(value.groups)) {
    throw new Error("资产对象分组清单格式无效，原文件已保留。");
  }

  const seen = new Set<AssetGroupId>();
  const groups: AssetGroupId[] = [];
  for (const candidate of value.groups) {
    if (candidate !== null && (typeof candidate !== "string" || !UUID_PATTERN.test(candidate))) {
      throw new Error("资产对象分组清单包含无效分组 ID，原文件已保留。");
    }
    if (seen.has(candidate)) throw new Error("资产对象分组清单含重复 ID，原文件已保留。");
    seen.add(candidate);
    groups.push(candidate);
  }
  return Object.freeze(groups);
}

export function assetGroupPath(id: AssetGroupId): string {
  validateGroupId(id);
  return `${DIRECTORY}/${id ?? "unclassified"}.json`;
}

export function createAssetObjectFiles(files: ProjectFiles) {
  const parsed = new Map<AssetGroupId, ParsedGroup>();
  const attempts = new Map<string, PendingWrite>();
  const safeEmptyOrphans = new Set<AssetGroupId>();

  function read(id: AssetGroupId): AssetGroupData {
    const path = assetGroupPath(id);
    const file = pathFile(files, path);
    if (!file) throw new Error(`资产对象分组文件“${path}”尚未加载。`);
    const bytes = fileData(file);
    const cached = parsed.get(id);
    if (cached?.bytes === bytes) return cached.data;
    let data: AssetGroupData;
    try {
      data = validateGroupData(id, decode(bytes));
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error("资产对象分组文件无法解析，原文件已保留。");
    }
    parsed.set(id, {bytes, data});
    return data;
  }

  return Object.freeze({
    async assertNoOrphanData(): Promise<void> {
      let listing;
      try { listing = await files.list(DIRECTORY); }
      catch { throw new Error("schema.json 缺失或对象分组目录无法读取，请恢复 schema.json 后重试。"); }
      if (!listing?.exists || listing.issues.some(issue => issue.path === DIRECTORY
        || issue.path.startsWith(DIRECTORY + "/"))) {
        throw new Error("schema.json 缺失或对象分组目录无法读取，请恢复 schema.json 后重试。");
      }

      const emptyGroups = new Set<AssetGroupId>();
      for (const entry of listing.entries) {
        let id: AssetGroupId;
        if (entry.name === "unclassified.json") {
          id = null;
        } else {
          const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/.exec(entry.name);
          if (!match) continue;
          id = match[1];
        }
        const path = assetGroupPath(id);
        if (entry.path !== path || entry.kind !== "file") {
          throw new Error("schema.json 缺失，对象分组文件路径无效或无法读取，请恢复 schema.json 后重试。");
        }
        try {
          if (!await files.read(path, {preferByteView: true})) throw new Error();
          const data = read(id);
          if (data.assets.length !== 0 || data.fields.length !== 0) throw new Error();
          emptyGroups.add(id);
        } catch {
          throw new Error("schema.json 缺失或对象分组文件损坏/包含数据，请恢复 schema.json 后重试。");
        }
      }
      safeEmptyOrphans.clear();
      for (const id of emptyGroups) safeEmptyOrphans.add(id);
    },

    async load(groups: readonly AssetGroupId[]): Promise<void> {
      const unique = new Set<AssetGroupId>();
      for (const id of groups) {
        validateGroupId(id);
        if (unique.has(id)) throw new Error("资产对象分组清单含重复 ID。");
        unique.add(id);
      }

      await Promise.all(groups.map(async id => {
        const path = assetGroupPath(id);
        if (!await files.read(path, {preferByteView: true})) {
          throw new Error(files.getSnapshot().error ?? `资产对象分组文件“${path}”缺失或无法读取。`);
        }
        read(id);
      }));
    },

    read,

    async saveGroup(id: AssetGroupId, data: AssetGroupData, existing: boolean): Promise<void> {
      const path = assetGroupPath(id);
      const validated = validateGroupData(id, data);
      let updateExisting = existing;
      if (updateExisting) read(id);
      else if (safeEmptyOrphans.has(id)) {
        const orphan = read(id);
        if (orphan.assets.length !== 0 || orphan.fields.length !== 0) {
          throw new Error("孤立对象分组已发生变化，无法覆盖。");
        }
        updateExisting = true;
      }
      await saveBytes(files, attempts, path, encode(validated), updateExisting, "保存资产对象分组失败，请重试。");
      safeEmptyOrphans.delete(id);
      read(id);
    },

    async saveManifest(groups: readonly AssetGroupId[], existing: boolean): Promise<void> {
      const seen = new Set<AssetGroupId>();
      const ordered: AssetGroupId[] = [];
      for (const id of groups) {
        validateGroupId(id);
        if (seen.has(id)) throw new Error("资产对象分组清单含重复 ID。");
        seen.add(id);
        ordered.push(id);
      }
      const bytes = encode({format: FORMAT, schemaVersion: SCHEMA_VERSION, groups: ordered});
      if (existing) {
        const file = pathFile(files, MANIFEST_PATH);
        if (!file) throw new Error("资产对象清单尚未加载。");
        let current: unknown;
        try { current = decode(fileData(file)); }
        catch { throw new Error("资产对象清单格式无效，原文件已保留。"); }
        const currentGroups = parseGroupManifest(current);
        if (currentGroups && currentGroups.some(id => !seen.has(id))) {
          throw new Error("资产对象清单在并发修改中新增了分组，当前草稿已保留，请重新加载后再保存。");
        }
      }
      for (const id of ordered) read(id);
      await saveBytes(files, attempts, MANIFEST_PATH, bytes, existing, "保存资产对象清单失败，请重试。");
    },

    dispose(): void {
      parsed.clear();
      attempts.clear();
      safeEmptyOrphans.clear();
    },
  });
}
