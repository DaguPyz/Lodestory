import {createAssetObjectFiles, parseGroupManifest, type AssetGroupData, type AssetGroupId} from "./assetObjectFiles";
import {createAssetTemplateStore, readLegacyTypeOrder, validateAssetTemplates} from "./assetTemplateStore";
import type {ProjectByteView, ProjectDirectoryListing, ProjectFile, ProjectFileData, ProjectFiles, ProjectSaveState} from "@lodestory/sdk/project-storage";

export type AssetValueType = "text" | "number" | "singleSelect" | "multiSelect" | "reference";

export type AssetFieldOption = Readonly<{
  id: string;
  title: string;
}>;

export type AssetFieldConfig = Readonly<{
  options?: readonly AssetFieldOption[];
  targetTypeId?: string | null;
}>;

export type AssetTypeTemplate = Readonly<{
  id: string;
  name: string;
  description: string;
  color?: string;
  order: number;
  status: "active" | "archived";
}>;

export type AssetPropertyValue = string | number | readonly string[] | null;

export type AssetRecord = Readonly<{
  id: string;
  name: string;
  description: string;
  typeId: string | null;
  color?: string;
  values: Readonly<Record<string, AssetPropertyValue>>;
}>;

export type AssetFieldOwner = Readonly<{kind: "type" | "asset"; id: string}>;

export type AssetFieldDefinition = Readonly<{
  id: string;
  owner: AssetFieldOwner;
  title: string;
  valueType: AssetValueType;
  config: AssetFieldConfig;
  defaultValue?: string | number | readonly string[] | null;
  order: number;
  status: "active" | "archived";
}>;

export type CreateAssetTypeInput = Readonly<{
  id: string;
  name: string;
  description: string;
  color?: string | null;
}>;

export type CreateAssetInput = Readonly<{
  id: string;
  name: string;
  description: string;
  typeId: string | null;
  color?: string | null;
  values?: Readonly<Record<string, AssetPropertyValue>>;
}>;

export type CreateAssetFieldInput = Omit<AssetFieldDefinition, "order" | "status">;

export type AssetSchemaSnapshot = Readonly<{
  types: readonly AssetTypeTemplate[];
  assets: readonly AssetRecord[];
  fields: readonly AssetFieldDefinition[];
  selectedTypeId: string | null;
  selectedAssetId: string | null;
  typeCreationRequest: number;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  reordering: boolean;
  pendingTypeRemoval: string | null;
  orderBlocked: boolean;
  dirty: boolean;
  blocked: boolean;
  error: string | null;
  saveState: ProjectSaveState;
}>;

export type AssetSchemaStore = Readonly<{
  getSnapshot(): AssetSchemaSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  selectType(id: string | null): boolean;
  requestTypeCreation(): boolean;
  selectAsset(id: string | null): boolean;
  createType(input: CreateAssetTypeInput): Promise<boolean>;
  removeType(id: string): Promise<boolean>;
  createAsset(input: CreateAssetInput): Promise<boolean>;
  updateAsset(id: string, patch: Readonly<{name?: string; description?: string; color?: string | null; values?: Readonly<Record<string, AssetPropertyValue>>}>): Promise<boolean>;
  removeAsset(id: string): Promise<boolean>;
  updateType(id: string, patch: Readonly<{name?: string; description?: string; color?: string | null}>): Promise<boolean>;
  moveType(id: string, direction: -1 | 1): Promise<boolean>;
  createField(input: CreateAssetFieldInput): Promise<boolean>;
  renameField(id: string, title: string): Promise<boolean>;
  removeAssetField(assetId: string, fieldId: string): Promise<boolean>;
  moveField(id: string, direction: -1 | 1): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): Promise<void>;
}>;

const PATH = ".lodestory/assets/schema.json";
const DIRECTORY = ".lodestory/assets";
const FORMAT = "lodestory.asset-schema";
const INLINE_DATA_VERSION = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FIELD_TITLE = 60;
const MAX_ASSET_NAME = 60;
const MAX_ASSET_DESCRIPTION = 200;
const ASSET_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 100;
const ASSET_FIELDS = ["description", "id", "name", "typeId", "values"];
const FIELD_FIELDS = ["config", "id", "order", "owner", "status", "title", "valueType"];
const CONFIG_FIELDS = ["options", "targetTypeId"];
const OPTION_FIELDS = ["id", "title"];
const LEGACY_DOCUMENT_FIELDS = ["fields", "format", "schemaVersion", "types"];
const DOCUMENT_FIELDS = ["assets", "fields", "format", "schemaVersion", "types"];

type SchemaData = Readonly<{
  types: readonly AssetTypeTemplate[];
  assets: readonly AssetRecord[];
  fields: readonly AssetFieldDefinition[];
}>;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function keysMatch(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  return required.every(key => hasOwn(value, key))
    && actual.every(key => allowed.includes(key));
}

function isByteView(bytes: ProjectFileData): bytes is ProjectByteView {
  return !Array.isArray(bytes) && !(bytes instanceof Uint8Array)
    && typeof bytes === "object" && bytes !== null
    && typeof (bytes as ProjectByteView).copyTo === "function"
    && typeof (bytes as ProjectByteView).equals === "function";
}

function decodeUtf8(bytes: ProjectFileData): string {
  if (isByteView(bytes)) {
    const buffer = new Uint8Array(bytes.byteLength);
    bytes.copyTo(buffer);
    return new TextDecoder("utf-8", {fatal: true}).decode(buffer);
  }
  return new TextDecoder("utf-8", {fatal: true}).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

function cloneConfig(config: AssetFieldConfig): AssetFieldConfig {
  const copy: {options?: readonly AssetFieldOption[]; targetTypeId?: string | null} = {};
  if (config.options !== undefined) {
    copy.options = Object.freeze(config.options.map(option => Object.freeze({id: option.id, title: option.title})));
  }
  if (hasOwn(config, "targetTypeId")) copy.targetTypeId = config.targetTypeId;
  return Object.freeze(copy);
}

function cloneDefault(value: AssetFieldDefinition["defaultValue"]): AssetFieldDefinition["defaultValue"] {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

function clonePropertyValue(value: AssetPropertyValue): AssetPropertyValue {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

function normalizeAssetColor(value: unknown): string | null {
  return typeof value === "string" && ASSET_COLOR_PATTERN.test(value) ? value.toLowerCase() : null;
}

function freezeAsset(asset: AssetRecord): AssetRecord {
  const values = Object.freeze(Object.fromEntries(Object.entries(asset.values).map(([id, value]) => [id, clonePropertyValue(value)])));
  return Object.freeze({id: asset.id, name: asset.name, description: asset.description, typeId: asset.typeId,
    ...(asset.color !== undefined ? {color: asset.color} : {}), values});
}

function freezeSchema(types: readonly AssetTypeTemplate[], fields: readonly AssetFieldDefinition[], assets: readonly AssetRecord[] = []): SchemaData {
  return Object.freeze({types: Object.freeze([...types]), assets: Object.freeze([...assets]), fields: Object.freeze([...fields])});
}

function orderIsValid(order: unknown): order is number {
  return typeof order === "number" && Number.isSafeInteger(order) && order >= 0;
}

function normalizeSchema(value: unknown, templates: readonly AssetTypeTemplate[] | null,
  otherGroups?: ReadonlyMap<AssetGroupId, AssetGroupData>, editingGroup?: AssetGroupId): {schema: SchemaData | null; error: string | null} {
  if (!isRecord(value)) {
    return {schema: null, error: "类型模板文件字段不完整或包含未知字段，已保留原始文件。"};
  }
  const version = value.schemaVersion;
  if (value.format !== FORMAT || version !== 1 && version !== 2 && version !== INLINE_DATA_VERSION) {
    return {schema: null, error: "类型模板文件格式或版本不受支持，已保留原始文件。"};
  }
  const expectedDocumentFields = version === 1 ? LEGACY_DOCUMENT_FIELDS
    : version === 2 ? DOCUMENT_FIELDS : ["assets", "fields", "format", "schemaVersion"];
  if (!keysMatch(value, expectedDocumentFields)) {
    return {schema: null, error: "类型模板文件字段不完整或包含未知字段，已保留原始文件。"};
  }
  if (!Array.isArray(value.fields) || version !== 1 && !Array.isArray(value.assets)) {
    return {schema: null, error: "资产类型和字段定义必须是数组，已保留原始文件。"};
  }

  if (version === INLINE_DATA_VERSION && templates === null) {
    return {schema: null, error: "资产数据缺少对应的 templates.json 模板列表，已保留原始文件。"};
  }
  const catalog = templates === null ? validateAssetTemplates(value.types) : {templates, error: null};
  if (!catalog.templates) return {schema: null, error: catalog.error};
  const types = catalog.templates;
  const typeIds = new Set(types.map(type => type.id));
  const globalIds = new Set(typeIds);
  const assetById = new Map<string, {typeId: AssetGroupId}>();
  // Only IDs from other groups participate in uniqueness and reference checks.
  for (const [id, group] of otherGroups ?? []) {
    if (id === editingGroup) continue;
    for (const asset of group.assets) {
      globalIds.add(asset.id);
      assetById.set(asset.id, asset);
    }
    for (const field of group.fields) {
      globalIds.add(field.id);
      for (const option of field.config.options ?? []) globalIds.add(option.id);
    }
  }

  const rawAssets: {id: string; name: string; description: string; typeId: string | null; color?: string; values: Record<string, unknown>}[] = [];
  const assetIds = new Set<string>();
  for (const candidate of version === 1 ? [] : value.assets as unknown[]) {
    if (!isRecord(candidate) || !keysMatch(candidate, ASSET_FIELDS, ["color"])) {
      return {schema: null, error: "资产记录字段不完整或包含未知字段，已保留原始文件。"};
    }
    if (!isUuid(candidate.id) || globalIds.has(candidate.id) || assetIds.has(candidate.id)) {
      return {schema: null, error: "资产 ID 无效或重复，已保留原始文件。"};
    }
    if (typeof candidate.name !== "string" || [...candidate.name.trim()].length < 1 || [...candidate.name.trim()].length > MAX_ASSET_NAME) {
      return {schema: null, error: `资产名称需为 trim 后 1 到 ${MAX_ASSET_NAME} 个字符，已保留原始文件。`};
    }
    if (typeof candidate.description !== "string" || [...candidate.description].length > MAX_ASSET_DESCRIPTION) {
      return {schema: null, error: `资产说明必须是文本且最多 ${MAX_ASSET_DESCRIPTION} 个字符，已保留原始文件。`};
    }
    if (candidate.typeId !== null && (!isUuid(candidate.typeId) || !typeIds.has(candidate.typeId))) {
      return {schema: null, error: "资产所属类型不存在或格式无效，已保留原始文件。"};
    }
    let color: string | undefined;
    if (hasOwn(candidate, "color")) {
      const normalizedColor = normalizeAssetColor(candidate.color);
      if (!normalizedColor) return {schema: null, error: "资产颜色必须是 #RRGGBB 格式，已保留原始文件。"};
      color = normalizedColor;
    }
    if (!isRecord(candidate.values)) return {schema: null, error: "资产属性值必须是对象，已保留原始文件。"};
    const id = candidate.id;
    assetIds.add(id);
    globalIds.add(id);
    rawAssets.push({id, name: candidate.name.trim(), description: candidate.description, typeId: candidate.typeId as string | null,
      ...(color !== undefined ? {color} : {}), values: candidate.values});
  }

  const fields: AssetFieldDefinition[] = [];
  const fieldIds = new Set<string>();
  const ownerOrders = new Map<string, Set<number>>();
  const activeTitles = new Map<string, Set<string>>();
  for (const candidate of value.fields) {
    if (!isRecord(candidate) || !keysMatch(candidate, FIELD_FIELDS, ["defaultValue"])) {
      return {schema: null, error: "资产字段定义不完整或包含未知字段，已保留原始文件。"};
    }
    if (!isUuid(candidate.id) || !orderIsValid(candidate.order)) {
      return {schema: null, error: "字段 ID 必须是 UUID，顺序必须是非负整数，已保留原始文件。"};
    }
    if (globalIds.has(candidate.id) || fieldIds.has(candidate.id)) {
      return {schema: null, error: "资产字段 ID 重复，已保留原始文件。"};
    }
    // Reserve the field ID before validating option IDs so an option cannot reuse it.
    fieldIds.add(candidate.id);
    globalIds.add(candidate.id);
    if (!isRecord(candidate.owner) || !keysMatch(candidate.owner, ["id", "kind"])
      || !["type", "asset"].includes(candidate.owner.kind as string) || !isUuid(candidate.owner.id)
      || candidate.owner.kind === "type" && !typeIds.has(candidate.owner.id)
      || candidate.owner.kind === "asset" && (version === 1 || !assetIds.has(candidate.owner.id))) {
      return {schema: null, error: "资产字段所属类型不存在或格式无效，已保留原始文件。"};
    }
    if (typeof candidate.title !== "string" || [...candidate.title.trim()].length < 1 || [...candidate.title.trim()].length > MAX_FIELD_TITLE) {
      return {schema: null, error: `资产字段标题需为 trim 后 1 到 ${MAX_FIELD_TITLE} 个字符，已保留原始文件。`};
    }
    if (!(["text", "number", "singleSelect", "multiSelect", "reference"] as unknown[]).includes(candidate.valueType)) {
      return {schema: null, error: "资产字段类型无效，已保留原始文件。"};
    }
    if (candidate.status !== "active" && candidate.status !== "archived") {
      return {schema: null, error: "资产字段状态无效，已保留原始文件。"};
    }
    if (!isRecord(candidate.config) || !keysMatch(candidate.config, [], CONFIG_FIELDS)) {
      return {schema: null, error: "资产字段配置格式无效，已保留原始文件。"};
    }

    const valueType = candidate.valueType as AssetValueType;
    const config = candidate.config;
    let options: readonly AssetFieldOption[] | undefined;
    if (hasOwn(config, "options")) {
      if (!Array.isArray(config.options)) return {schema: null, error: "字段选项必须是数组，已保留原始文件。"};
      if (valueType !== "singleSelect" && valueType !== "multiSelect") {
        return {schema: null, error: "只有单选和多选字段可以配置选项，已保留原始文件。"};
      }
      if (config.options.length < MIN_OPTIONS || config.options.length > MAX_OPTIONS) {
        return {schema: null, error: `字段选项数量需为 ${MIN_OPTIONS} 到 ${MAX_OPTIONS}，已保留原始文件。`};
      }
      const normalizedOptions: AssetFieldOption[] = [];
      const optionTitles = new Set<string>();
      for (const option of config.options) {
        if (!isRecord(option) || !keysMatch(option, OPTION_FIELDS)) {
          return {schema: null, error: "字段选项不完整或包含未知字段，已保留原始文件。"};
        }
        if (!isUuid(option.id) || globalIds.has(option.id) || fieldIds.has(option.id)) {
          return {schema: null, error: "字段选项 ID 无效或重复，已保留原始文件。"};
        }
        if (typeof option.title !== "string" || [...option.title.trim()].length < 1 || [...option.title.trim()].length > MAX_FIELD_TITLE) {
          return {schema: null, error: `字段选项标题需为 trim 后 1 到 ${MAX_FIELD_TITLE} 个字符，已保留原始文件。`};
        }
        const title = option.title.trim();
        const titleKey = title.toLocaleLowerCase();
        if (optionTitles.has(titleKey)) return {schema: null, error: "同一字段中的选项标题不能重复，已保留原始文件。"};
        optionTitles.add(titleKey);
        globalIds.add(option.id);
        normalizedOptions.push(Object.freeze({id: option.id, title}));
      }
      options = Object.freeze(normalizedOptions);
    }
    if ((valueType === "singleSelect" || valueType === "multiSelect") && options === undefined) {
      return {schema: null, error: "单选和多选字段必须包含选项列表，已保留原始文件。"};
    }
    let targetTypeId: string | null | undefined;
    if (hasOwn(config, "targetTypeId")) {
      if (valueType !== "reference") return {schema: null, error: "只有关联字段可以指定目标类型，已保留原始文件。"};
      if (config.targetTypeId !== null && (!isUuid(config.targetTypeId) || !typeIds.has(config.targetTypeId))) {
        return {schema: null, error: "关联字段的目标类型不存在，已保留原始文件。"};
      }
      targetTypeId = config.targetTypeId as string | null;
    }
    if (valueType === "reference" && hasOwn(candidate, "defaultValue")) {
      return {schema: null, error: "关联字段暂不支持默认值，已保留原始文件。"};
    }

    const ownerId = candidate.owner.id as string;
    const ownerKind = candidate.owner.kind as "type" | "asset";
    const ownerKey = `${ownerKind}:${ownerId}`;
    const orders = ownerOrders.get(ownerKey) ?? new Set<number>();
    if (orders.has(candidate.order)) return {schema: null, error: "同一对象内的字段顺序重复，已保留原始文件。"};
    orders.add(candidate.order);
    ownerOrders.set(ownerKey, orders);
    const titleKey = (candidate.title as string).trim().toLowerCase();
    if (candidate.status === "active") {
      const titles = activeTitles.get(ownerKey) ?? new Set<string>();
      if (titles.has(titleKey)) return {schema: null, error: "同一对象中的启用字段标题不能重复，已保留原始文件。"};
      titles.add(titleKey);
      activeTitles.set(ownerKey, titles);
    }

    const normalizedConfig: {options?: readonly AssetFieldOption[]; targetTypeId?: string | null} = {};
    if (options !== undefined) normalizedConfig.options = options;
    if (targetTypeId !== undefined) normalizedConfig.targetTypeId = targetTypeId;
    let defaultValue: AssetFieldDefinition["defaultValue"];
    if (hasOwn(candidate, "defaultValue")) {
      const supplied = candidate.defaultValue;
      if (supplied === null) defaultValue = null;
      else if (valueType === "text" && typeof supplied === "string") defaultValue = supplied;
      else if (valueType === "number" && typeof supplied === "number" && Number.isFinite(supplied)) defaultValue = Object.is(supplied, -0) ? 0 : supplied;
      else if (valueType === "singleSelect" && typeof supplied === "string" && options?.some(option => option.id === supplied)) defaultValue = supplied;
      else if (valueType === "multiSelect" && Array.isArray(supplied) && supplied.every(item => typeof item === "string" && options?.some(option => option.id === item))
        && new Set(supplied).size === supplied.length) defaultValue = Object.freeze([...supplied]);
      else return {schema: null, error: "字段默认值与字段类型或选项不兼容，已保留原始文件。"};
    }

    const normalized: AssetFieldDefinition = Object.freeze({
      id: candidate.id,
      owner: Object.freeze({kind: ownerKind, id: ownerId}),
      title: (candidate.title as string).trim(),
      valueType,
      config: Object.freeze(normalizedConfig),
      ...(hasOwn(candidate, "defaultValue") ? {defaultValue} : {}),
      order: candidate.order as number,
      status: candidate.status,
    });
    fields.push(normalized);
  }

  const fieldById = new Map(fields.map(field => [field.id, field]));
  const normalizedAssets: AssetRecord[] = [];
  for (const asset of rawAssets) assetById.set(asset.id, asset);
  for (const asset of rawAssets) {
    const values: Record<string, AssetPropertyValue> = {};
    for (const [fieldId, supplied] of Object.entries(asset.values)) {
      const field = fieldById.get(fieldId);
      if (!field) return {schema: null, error: "资产包含未定义的属性字段，已保留原始文件。"};
      const ownerMatches = field.owner.kind === "type" ? asset.typeId === field.owner.id : asset.id === field.owner.id;
      if (!ownerMatches) return {schema: null, error: "资产属性字段与资产类型或所属对象不匹配，已保留原始文件。"};
      if (supplied === null) {
        values[fieldId] = null;
      } else if (field.valueType === "text" && typeof supplied === "string") {
        values[fieldId] = supplied;
      } else if (field.valueType === "number" && typeof supplied === "number" && Number.isFinite(supplied)) {
        values[fieldId] = Object.is(supplied, -0) ? 0 : supplied;
      } else if (field.valueType === "singleSelect" && typeof supplied === "string" && field.config.options?.some(option => option.id === supplied)) {
        values[fieldId] = supplied;
      } else if (field.valueType === "multiSelect" && Array.isArray(supplied)
        && supplied.every(item => typeof item === "string" && field.config.options?.some(option => option.id === item))
        && new Set(supplied).size === supplied.length) {
        values[fieldId] = Object.freeze([...supplied]);
      } else if (field.valueType === "reference" && typeof supplied === "string") {
        const target = assetById.get(supplied);
        const targetTypeId = field.config.targetTypeId;
        if (!target || targetTypeId != null && target.typeId !== targetTypeId) {
          return {schema: null, error: "资产关联值指向不存在或类型不匹配的资产，已保留原始文件。"};
        }
        values[fieldId] = supplied;
      } else {
        return {schema: null, error: "资产属性值与字段类型或选项不兼容，已保留原始文件。"};
      }
    }
    normalizedAssets.push(Object.freeze({id: asset.id, name: asset.name, description: asset.description, typeId: asset.typeId,
      ...(asset.color !== undefined ? {color: asset.color} : {}), values: Object.freeze(values)}));
  }

  return {schema: freezeSchema(types, fields, normalizedAssets), error: null};
}

const emptyGroup: AssetGroupData = Object.freeze({assets: Object.freeze([]), fields: Object.freeze([])});

function groupRecords(body: AssetGroupData): Map<AssetGroupId, AssetGroupData> {
  const groups = new Map<AssetGroupId, {assets: AssetRecord[]; fields: AssetFieldDefinition[]}>();
  function group(id: AssetGroupId) {
    let result = groups.get(id);
    if (!result) {
      result = {assets: [], fields: []};
      groups.set(id, result);
    }
    return result;
  }
  const assetTypes = new Map<string, AssetGroupId>();
  for (const asset of body.assets) {
    assetTypes.set(asset.id, asset.typeId);
    group(asset.typeId).assets.push(asset);
  }
  for (const field of body.fields) {
    const typeId = field.owner.kind === "type" ? field.owner.id : assetTypes.get(field.owner.id);
    if (typeId === undefined) throw new Error("字段所属对象不存在。");
    group(typeId).fields.push(field);
  }
  return groups;
}

function sameRecords<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || left.length === right.length && left.every((item, index) => item === right[index]);
}

function decodeSchemaFile(bytes: ProjectFileData): {value?: unknown; groups?: readonly AssetGroupId[]; error?: string} {
  let text: string;
  try { text = decodeUtf8(bytes); }
  catch { return {error: "schema.json 不是有效的 UTF-8 文件。"}; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return {error: "资产数据文件已损坏，请检查 schema.json。"}; }
  try {
    const groups = parseGroupManifest(value);
    return groups ? {groups} : {value};
  } catch (cause) {
    return {error: cause instanceof Error ? cause.message : "资产对象文件清单格式无效。"};
  }
}

function sameFieldInput(field: AssetFieldDefinition, input: CreateAssetFieldInput): boolean {
  const candidate = {
    id: input.id,
    owner: {kind: input.owner.kind, id: input.owner.id},
    title: input.title.trim(),
    valueType: input.valueType,
    config: cloneConfig(input.config),
    ...(input.defaultValue !== undefined ? {defaultValue: cloneDefault(input.defaultValue)} : {}),
  };
  const current = {
    id: field.id,
    owner: field.owner,
    title: field.title,
    valueType: field.valueType,
    config: field.config,
    ...(hasOwn(field, "defaultValue") ? {defaultValue: field.defaultValue} : {}),
  };
  return JSON.stringify(current) === JSON.stringify(candidate);
}

export function createAssetSchemaStore(files: ProjectFiles): AssetSchemaStore {
  const listeners = new Set<() => void>();
  let schema = freezeSchema([], [], []);
  let selectedTypeId: string | null = null;
  let selectedAssetId: string | null = null;
  let typeSelectionInitialized = false;
  let assetSelectionInitialized = false;
  let typeCreationRequest = 0;
  let pendingTemplateEdit: {id: string; isNew: boolean} | null = null;
  const pendingAssetIds = new Set<string>();
  const pendingFieldIds = new Set<string>();
  let loaded = false;
  let loading = false;
  let mutating = false;
  const templateStore = createAssetTemplateStore(files);
  let legacyOrder: readonly string[] | null = null;
  let legacyOrderError: string | null = null;
  let catalogReferenceError: string | null = null;
  let pendingRemoval: string | null = null;
  let moving = 0;
  let knownFile = false;
  let localBlocked = false;
  let localError: string | null = null;
  let alive = true;
  let generation = 0;
  let loadOperation: Promise<boolean> | null = null;
  let mutationOperation: Promise<boolean> | null = null;
  const objectFiles = createAssetObjectFiles(files);
  // null denotes an inline legacy body (or a new project without a manifest).
  let manifestGroups: readonly AssetGroupId[] | null = null;
  let groups = new Map<AssetGroupId, AssetGroupData>();
  let legacyGroups = groups;
  let pendingGroup: {id: AssetGroupId; data: AssetGroupData} | null = null;
  let schemaBytes: ProjectFileData | null = null;
  const acceptedGroups = new Map<AssetGroupId, AssetGroupData>();
  let parsedBytes: ProjectFileData | null = null;
  let document: ReturnType<typeof decodeSchemaFile> = {};
  let snapshot = buildSnapshot();

  function currentTypes(): readonly AssetTypeTemplate[] {
    return templateStore.getSnapshot().templates ?? schema.types;
  }

  // An external catalog edit can remove an ID still used in the data file.
  // Reordering or renaming keeps the same IDs and never visits assets or fields.
  let checkedTypes = currentTypes();
  const unsubscribeTemplates = templateStore.subscribe(() => {
    const types = currentTypes();
    if (checkedTypes !== types && loaded) {
      const ids = new Set(types.map(type => type.id));
      if (ids.size !== checkedTypes.length || checkedTypes.some(type => !ids.has(type.id))) {
        const invalid = schema.assets.some(asset => ids.has(asset.id) || asset.typeId !== null && !ids.has(asset.typeId))
          || schema.fields.some(field => ids.has(field.id) || field.owner.kind === "type" && !ids.has(field.owner.id)
            || field.config.targetTypeId != null && !ids.has(field.config.targetTypeId)
            || field.config.options?.some(option => ids.has(option.id)));
        catalogReferenceError = invalid ? "模板列表与资产或字段的 ID 不匹配，请检查项目文件。" : null;
      }
      reconcileTypeSelection();
    }
    checkedTypes = types;
    const catalog = templateStore.getSnapshot();
    if (catalog.loaded && !catalog.dirty && !catalog.saving && !catalog.error) pendingTemplateEdit = null;
    publish();
  });

  async function loadTemplates(listing?: ProjectDirectoryListing): Promise<boolean> {
    if (!await templateStore.load(listing)) return false;
    legacyOrder = null;
    legacyOrderError = null;
    if (templateStore.getSnapshot().templates === null) {
      try { legacyOrder = await readLegacyTypeOrder(files, listing); }
      catch (cause) { legacyOrderError = cause instanceof Error ? cause.message : "读取旧模板顺序失败。"; }
    }
    return true;
  }

  function readDocument(file: ProjectFile) {
    const bytes = file.byteView ?? file.bytes;
    if (bytes !== parsedBytes) {
      parsedBytes = bytes;
      document = decodeSchemaFile(bytes);
    }
    return document;
  }

  function dataFiles(source = files.getSnapshot()) {
    return source.files.filter(file => file.path === PATH || file.path.startsWith(DIRECTORY + "/objects/"));
  }

  function fileFrom(sourceFiles = files.getSnapshot().files): ProjectFile | undefined {
    return sourceFiles.find(file => file.path === PATH);
  }

  function buildSnapshot(source = files.getSnapshot()): AssetSchemaSnapshot {
    const file = dataFiles(source).find(file => file.dirty || file.saveState === "error") ?? fileFrom(source.files);
    const catalog = templateStore.getSnapshot();
    const dirty = pendingGroup !== null || Boolean(file?.dirty) || catalog.dirty || catalog.saving || pendingRemoval !== null;
    const saveState: ProjectSaveState = mutating || catalog.saving ? "saving"
      : dirty ? (localError || catalog.error || file?.saveState === "error" ? "error" : "pending")
        : file?.saveState ?? "saved";
    return Object.freeze({
      types: currentTypes(),
      assets: schema.assets,
      fields: schema.fields,
      selectedTypeId,
      selectedAssetId,
      typeCreationRequest,
      loaded,
      loading,
      saving: loading || mutating || saveState === "pending" || saveState === "saving",
      reordering: moving > 0 && catalog.saving && !mutating && !file?.dirty,
      pendingTypeRemoval: pendingRemoval,
      orderBlocked: catalog.blocked || !catalog.loaded || legacyOrderError !== null,
      dirty,
      blocked: source.blocked || localBlocked || catalog.blocked || catalogReferenceError !== null,
      error: localError ?? catalogReferenceError ?? catalog.error ?? legacyOrderError ?? file?.saveError ?? (saveState === "error" ? "类型模板保存失败，请重试。" : null),
      saveState,
    });
  }

  function publish() {
    if (!alive) return;
    const next = buildSnapshot();
    if (snapshot.types === next.types && snapshot.assets === next.assets && snapshot.fields === next.fields
      && snapshot.selectedTypeId === next.selectedTypeId && snapshot.selectedAssetId === next.selectedAssetId
      && snapshot.typeCreationRequest === next.typeCreationRequest && snapshot.loaded === next.loaded
      && snapshot.loading === next.loading && snapshot.saving === next.saving && snapshot.reordering === next.reordering
      && snapshot.pendingTypeRemoval === next.pendingTypeRemoval && snapshot.orderBlocked === next.orderBlocked && snapshot.dirty === next.dirty
      && snapshot.blocked === next.blocked && snapshot.error === next.error && snapshot.saveState === next.saveState) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function clearPendingIds() {
    pendingAssetIds.clear();
    pendingFieldIds.clear();
  }

  function reconcileTypeSelection() {
    if (!templateStore.getSnapshot().loaded) return;
    const types = currentTypes();
    if (typeSelectionInitialized && (selectedTypeId === null || types.some(type => type.id === selectedTypeId))) return;
    selectedTypeId = types.find(type => type.status === "active")?.id ?? null;
    typeSelectionInitialized = true;
  }

  function reconcileAssetSelection() {
    const firstAssetId = schema.assets[0]?.id ?? null;
    if (!assetSelectionInitialized) {
      selectedAssetId = firstAssetId;
      assetSelectionInitialized = true;
    } else if (selectedAssetId !== null && !schema.assets.some(asset => asset.id === selectedAssetId)) {
      selectedAssetId = firstAssetId;
    }
  }

  function acceptFile(file: ProjectFile, requestGeneration?: number): boolean {
    if (!alive || requestGeneration !== undefined && requestGeneration !== generation) return false;
    const bytes = file.byteView ?? file.bytes;
    try {
      const doc = readDocument(file);
      if (doc.error) throw new Error(doc.error);
      const templates = templateStore.getSnapshot().templates;
      const rawGroups = new Map<AssetGroupId, AssetGroupData>();
      let body = doc.value;
      if (doc.groups) {
        for (const id of doc.groups) rawGroups.set(id, objectFiles.read(id));
        const values = [...rawGroups.values()];
        body = {format: FORMAT, schemaVersion: INLINE_DATA_VERSION,
          assets: values.flatMap(group => group.assets), fields: values.flatMap(group => group.fields)};
      }
      const parsed = normalizeSchema(body, templates);
      if (!parsed.schema) throw new Error(parsed.error ?? "资产数据无效。");
      schema = parsed.schema;
      if (!templates && legacyOrder) {
        const rank = new Map(legacyOrder.map((id, i) => [id, i]));
        const sorted = [...schema.types].sort((a, b) =>
          (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size) || a.order - b.order);
        schema = {...schema, types: Object.freeze(sorted.map((type, order) => Object.freeze({...type, order})))};
      }
      groups = groupRecords(schema);
      manifestGroups = doc.groups ?? null;
      legacyGroups = manifestGroups ? new Map() : groups;
      acceptedGroups.clear();
      for (const [id, group] of rawGroups) acceptedGroups.set(id, group);
      schemaBytes = bytes;
    } catch (cause) {
      loaded = false;
      localBlocked = true;
      localError = cause instanceof Error ? cause.message : "资产数据读取失败。";
      return false;
    }
    checkedTypes = currentTypes();
    catalogReferenceError = null;
    reconcileTypeSelection();
    reconcileAssetSelection();
    knownFile = true;
    if (!file.dirty && file.saveState === "saved") clearPendingIds();
    loaded = true;
    localBlocked = false;
    localError = null;
    return true;
  }

  function syncSharedFiles() {
    if (!alive || loading || !templateStore.getSnapshot().loaded || templateStore.getSnapshot().blocked) return;
    const file = fileFrom();
    if (!pendingGroup && file) {
      try {
        if (schemaBytes !== (file.byteView ?? file.bytes)
          || manifestGroups?.some(id => objectFiles.read(id) !== acceptedGroups.get(id))) acceptFile(file);
      } catch (cause) {
        loaded = false;
        localBlocked = true;
        localError = cause instanceof Error ? cause.message : "资产对象文件缺失或损坏。";
      }
      if (!dataFiles().some(item => item.dirty) && !mutating) clearPendingIds();
    } else if (!pendingGroup && knownFile && !file) {
      loaded = false;
      localBlocked = true;
      localError = "资产数据文件 schema.json 缺失，请恢复后重试。";
    }
    publish();
  }
  const unsubscribe = files.subscribe(syncSharedFiles);

  async function loadBody(file: ProjectFile, requestGeneration: number): Promise<boolean> {
    const doc = readDocument(file);
    if (doc.groups) await objectFiles.load(doc.groups);
    if (!alive || requestGeneration !== generation) return false;
    return acceptFile(fileFrom() ?? file, requestGeneration);
  }

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loaded && !snapshot.blocked && !legacyOrderError && templateStore.getSnapshot().loaded) return Promise.resolve(true);
    if (loadOperation) return loadOperation;
    if (pendingGroup) return Promise.resolve(false);
    const requestGeneration = ++generation;
    loading = true;
    localError = null;
    localBlocked = false;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    loadOperation = operation;
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
          if (!alive) return false;
          if (!await loadTemplates()) { loaded = false; return false; }
          if (!alive || requestGeneration !== generation) return false;
          const latest = fileFrom();
          if (!latest) {
            loaded = false;
            localError = "资产文件在读取期间发生变化，请重试。";
            return false;
          }
          const valid = await loadBody(latest, requestGeneration);
          publish();
          return valid;
        }
        let listing: Awaited<ReturnType<ProjectFiles["list"]>>;
        try { listing = await listingOperation!; }
        catch (cause) {
          if (!alive || requestGeneration !== generation) return false;
          loaded = false;
          localError = cause instanceof Error ? cause.message : "读取类型模板目录失败。";
          publish();
          return false;
        }
        if (!alive || requestGeneration !== generation) return false;
        if (!listing) {
          loaded = false;
          localError = files.getSnapshot().blocked ? files.getSnapshot().error : "读取类型模板目录失败。";
          publish();
          return false;
        }
        if (!await loadTemplates(listing)) { loaded = false; return false; }
        if (!alive || requestGeneration !== generation) return false;
        const entry = listing.entries.find(candidate => candidate.name === "schema.json" || candidate.path === PATH);
        const issue = listing.issues.find(candidate => candidate.path === PATH || candidate.path === "schema.json");
        if (issue) {
          loaded = false;
          localBlocked = true;
          localError = issue.message;
          publish();
          return false;
        }
        if (!entry) {
          if (knownFile) throw new Error("资产数据文件 schema.json 缺失，请恢复后重试。");
          if (listing.entries.some(item => item.name === "objects") || listing.issues.some(item => item.path.endsWith("/objects"))) {
            await objectFiles.assertNoOrphanData();
            if (!alive || requestGeneration !== generation) return false;
          }
          schema = freezeSchema([], [], []);
          reconcileTypeSelection();
          checkedTypes = currentTypes();
          catalogReferenceError = null;
          selectedAssetId = null;
          assetSelectionInitialized = true;
          loaded = true;
          knownFile = false;
          localBlocked = false;
          localError = null;
          publish();
          return true;
        }
        if (entry.kind !== "file" || entry.path !== PATH) {
          loaded = false;
          localBlocked = true;
          localError = "类型模板文件路径不是普通文件，已保留原始内容。";
          publish();
          return false;
        }
        let readOperation: ReturnType<ProjectFiles["read"]>;
        try { readOperation = files.read(PATH, {preferByteView: true}); }
        catch (cause) { readOperation = Promise.reject(cause); }
        let file: ProjectFile | null = null;
        let readFailure: unknown = null;
        try { file = await readOperation; }
        catch (cause) { readFailure = cause; }
        if (!alive || requestGeneration !== generation) return false;
        if (file) {
          const valid = await loadBody(file, requestGeneration);
          publish();
          return valid;
        }
        const retainedFile = fileFrom();
        if (retainedFile && (retainedFile.dirty || retainedFile.saveState === "saving" || retainedFile.saveState === "pending")) {
          const valid = await loadBody(retainedFile, requestGeneration);
          publish();
          return valid;
        }
        loaded = false;
        localError = files.getSnapshot().blocked ? files.getSnapshot().error
          : readFailure instanceof Error ? readFailure.message : "类型模板文件读取失败，原始内容已保留。";
        publish();
        return false;
      } catch (cause) {
        if (!alive || requestGeneration !== generation) return false;
        loaded = false;
        localBlocked = true;
        localError = cause instanceof Error ? cause.message : "读取类型模板失败。";
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
    if (!alive || files.getSnapshot().blocked || localBlocked || !pendingGroup) return false;
    const {id, data} = pendingGroup;
    if (templateStore.getSnapshot().templates === null && !await templateStore.save(schema.types)) return false;
    const ensureCurrentManifest = () => {
      if (!alive || files.getSnapshot().blocked || snapshot.blocked) throw new Error("项目已暂停写入。");
      const current = fileFrom();
      if (knownFile && (!current || (current.byteView ?? current.bytes) !== schemaBytes)) {
        throw new Error("资产文件清单在编辑期间被修改，已保留待保存的内容。");
      }
    };
    ensureCurrentManifest();
    const nextIds = new Set(manifestGroups ?? legacyGroups.keys());
    nextIds.add(id);
    if (!manifestGroups || nextIds.size !== manifestGroups.length) {
      // Stage deterministic baseline files before switching the manifest. A restart can reuse
      // any files created before a failure, even if the next edit is different.
      for (const id of nextIds) {
        if (!alive || snapshot.blocked) return false;
        if (!manifestGroups?.includes(id)) await objectFiles.saveGroup(id, legacyGroups.get(id) ?? emptyGroup, false);
      }
      ensureCurrentManifest();
      const ids = [...nextIds];
      try {
        await objectFiles.saveManifest(ids, knownFile);
      } catch (error) {
        // ProjectFiles may already hold our new manifest while its disk write is pending retry.
        const current = fileFrom();
        if (current && sameRecords(readDocument(current).groups ?? [], ids)) schemaBytes = current.byteView ?? current.bytes;
        throw error;
      }
      manifestGroups = ids;
      knownFile = true;
      const manifest = fileFrom()!;
      schemaBytes = manifest.byteView ?? manifest.bytes;
      readDocument(manifest);
      for (const id of nextIds) {
        if (!acceptedGroups.has(id)) acceptedGroups.set(id, objectFiles.read(id));
      }
      legacyGroups = new Map();
    }
    ensureCurrentManifest();
    if (objectFiles.read(id) !== acceptedGroups.get(id)) throw new Error("当前模板的对象文件在编辑期间被修改，已保留待保存的内容。");
    try {
      await objectFiles.saveGroup(id, data, true);
    } catch (error) {
      const buffered = objectFiles.read(id);
      if (JSON.stringify(buffered) === JSON.stringify(data)) acceptedGroups.set(id, buffered);
      throw error;
    }
    acceptedGroups.set(id, objectFiles.read(id));
    pendingGroup = null;
    localError = null;
    syncSharedFiles();
    return true;
  }

  function groupForOwner(owner: AssetFieldOwner): AssetGroupId {
    return owner.kind === "type" ? owner.id : schema.assets.find(asset => asset.id === owner.id)!.typeId;
  }

  function mutateGroup(id: AssetGroupId, changes: Partial<AssetGroupData>,
    nextSelectedTypeId = selectedTypeId, nextSelectedAssetId = selectedAssetId): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || snapshot.orderBlocked || mutating || templateStore.getSnapshot().saving || templateStore.getSnapshot().dirty) return Promise.resolve(false);
    if (!pendingGroup && dataFiles().some(file => file.dirty || file.saveState === "saving")) return Promise.resolve(false);
    if (pendingGroup && pendingGroup.id !== id) {
      localError = "请先保存当前模板的修改，再编辑其他模板。";
      publish();
      return Promise.resolve(false);
    }
    const before = groups.get(id) ?? emptyGroup;
    const checked = normalizeSchema({format: FORMAT, schemaVersion: INLINE_DATA_VERSION, ...before, ...changes}, currentTypes(), groups, id);
    if (!checked.schema) {
      localError = checked.error;
      publish();
      return Promise.resolve(false);
    }
    const next = {assets: checked.schema.assets, fields: checked.schema.fields};
    const previousAssetIds = new Set(before.assets.map(asset => asset.id));
    const previousFieldIds = new Set(before.fields.map(field => field.id));
    for (const field of next.fields) if (!previousFieldIds.has(field.id)) pendingFieldIds.add(field.id);
    for (const asset of next.assets) if (!previousAssetIds.has(asset.id)) pendingAssetIds.add(asset.id);
    pendingGroup = {id, data: next};
    // Keep the legacy baseline immutable until the v4 manifest has committed.
    groups = new Map(groups).set(id, next);
    const parts = [...groups.values()];
    schema = {types: currentTypes(),
      assets: Object.freeze(parts.flatMap(group => group.assets)), fields: Object.freeze(parts.flatMap(group => group.fields))};
    selectedTypeId = nextSelectedTypeId;
    typeSelectionInitialized = true;
    selectedAssetId = nextSelectedAssetId && schema.assets.some(asset => asset.id === nextSelectedAssetId) ? nextSelectedAssetId : null;
    assetSelectionInitialized = true;
    localError = null;
    return persistMutation();
  }

  function persistMutation(): Promise<boolean> {
    mutating = true;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    mutationOperation = operation;
    publish();
    void persistCurrent().then(saved => saved && finishPendingRemoval()).catch(cause => {
      if (alive) localError = cause instanceof Error ? cause.message : "保存类型模板失败，请重试。";
      return false;
    }).then(result => {
      if (alive) {
        if (result) {
          clearPendingIds();
        }
        mutating = false;
        publish();
      }
      if (mutationOperation === operation) mutationOperation = null;
      resolveOperation(Boolean(result));
    });
    return operation;
  }

  function settleNoop(): Promise<boolean> {
    const file = fileFrom();
    if (snapshot.dirty || file?.saveState === "pending" || file?.saveState === "saving" || file?.saveState === "error") {
      return retry();
    }
    if (localError) {
      localError = null;
      publish();
    }
    return Promise.resolve(true);
  }

  function canEdit(): boolean {
    return alive && loaded && !snapshot.blocked && !snapshot.orderBlocked && !mutating && pendingRemoval === null;
  }

  function selectType(id: string | null): boolean {
    if (!alive || id !== null && !currentTypes().some(type => type.id === id)) return false;
    typeSelectionInitialized = true;
    if (selectedTypeId !== id) {
      selectedTypeId = id;
      publish();
    }
    return true;
  }

  function requestTypeCreation(): boolean {
    if (!canEdit() || snapshot.saving || snapshot.dirty) return false;
    typeCreationRequest++;
    publish();
    return true;
  }

  function selectAsset(id: string | null): boolean {
    if (!alive || id !== null && !schema.assets.some(asset => asset.id === id)) return false;
    assetSelectionInitialized = true;
    if (selectedAssetId !== id) {
      selectedAssetId = id;
      publish();
    }
    return true;
  }

  function saveTemplates(types: readonly AssetTypeTemplate[], selection: string | null, edit?: {id: string; isNew: boolean}): Promise<boolean> {
    const catalog = templateStore.getSnapshot();
    if (catalog.saving || pendingGroup || dataFiles().some(file => file.dirty) || catalog.dirty && (!edit || edit.id !== pendingTemplateEdit?.id)) {
      return Promise.resolve(false);
    }
    const checked = validateAssetTemplates(types);
    if (!checked.templates) {
      localError = checked.error;
      publish();
      return Promise.resolve(false);
    }
    pendingTemplateEdit = edit ?? null;
    selectedTypeId = selection;
    typeSelectionInitialized = true;
    localError = null;
    return templateStore.save(checked.templates).then(saved => {
      if (saved) pendingTemplateEdit = null;
      publish();
      return saved;
    });
  }

  async function finishPendingRemoval(): Promise<boolean> {
    if (pendingRemoval === null) return true;
    const id = pendingRemoval;
    if (!alive || snapshot.blocked) return false;
    if (schema.assets.some(asset => asset.typeId === id) || schema.fields.some(field =>
      field.owner.kind === "type" && field.owner.id === id || field.config.targetTypeId === id)) {
      pendingRemoval = null;
      localError = "删除期间资产或字段引用了此模板，模板已保留。";
      publish();
      return false;
    }
    const types = currentTypes().filter(type => type.id !== id);
    const saved = currentTypes().some(type => type.id === id)
      ? await templateStore.save(types) : await templateStore.retry();
    if (saved) pendingRemoval = null;
    publish();
    return saved;
  }

  function createType(input: CreateAssetTypeInput): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    if (!isRecord(input)) {
      localError = "资产类型输入格式无效。";
      publish();
      return Promise.resolve(false);
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const color = input.color == null ? undefined : normalizeAssetColor(input.color);
    if (color === null) {
      localError = "资产模板颜色必须是 #RRGGBB 格式。";
      publish();
      return Promise.resolve(false);
    }
    if (!isUuid(input.id) || !name || typeof input.description !== "string") {
      localError = "资产类型需要有效 UUID、名称和文本说明。";
      publish();
      return Promise.resolve(false);
    }
    const existing = currentTypes().find(type => type.id === input.id);
    if (existing) {
      if (existing.name !== name || existing.description !== input.description || existing.color !== color) {
        if (pendingTemplateEdit?.isNew && pendingTemplateEdit.id === input.id) return updateType(input.id, {name, description: input.description, color: color ?? null});
        localError = "资产类型 ID 已被其他类型使用。";
        publish();
        return Promise.resolve(false);
      }
      return settleNoop();
    }
    if (currentTypes().some(type => type.status === "active" && type.name.toLowerCase() === name.toLowerCase())) {
      localError = "已存在同名的启用类型。";
      publish();
      return Promise.resolve(false);
    }
    const order = currentTypes().reduce((maximum, type) => Math.max(maximum, type.order), -1) + 1;
    const type: AssetTypeTemplate = Object.freeze({id: input.id, name, description: input.description, ...(color !== undefined ? {color} : {}), order, status: "active"});
    if (schema.assets.some(asset => asset.id === type.id) || schema.fields.some(field =>
      field.id === type.id || field.config.options?.some(option => option.id === type.id))) {
      localError = "资产类型与已有资产、字段或选项的 ID 重复。";
      publish();
      return Promise.resolve(false);
    }
    return saveTemplates([...currentTypes(), type], type.id, {id: type.id, isNew: true});
  }

  function removeType(id: string): Promise<boolean> {
    if (id === pendingRemoval) return retry();
    if (!canEdit()) return Promise.resolve(false);
    const target = currentTypes().find(type => type.id === id);
    if (!target) return settleNoop();

    const assignedAssets = schema.assets.filter(asset => asset.typeId === id);
    const externalReferenceFields = schema.fields.filter(field => field.valueType === "reference"
      && field.config.targetTypeId === id
      && !(field.owner.kind === "type" && field.owner.id === id));
    if (assignedAssets.length > 0 || externalReferenceFields.length > 0) {
      const reasons: string[] = [];
      if (assignedAssets.length > 0) {
        reasons.push(`仍有资产使用此类型：${assignedAssets.map(asset => `“${asset.name}”`).join("、")}`);
      }
      if (externalReferenceFields.length > 0) {
        const names = externalReferenceFields.map(field => {
          const ownerName = field.owner.kind === "type"
            ? currentTypes().find(type => type.id === field.owner.id)?.name ?? field.owner.id
            : schema.assets.find(asset => asset.id === field.owner.id)?.name ?? field.owner.id;
          return `“${field.title}”（${ownerName}）`;
        });
        reasons.push(`以下字段仍以此类型为关联目标：${names.join("、")}`);
      }
      localError = `无法删除类型“${target.name}”：${reasons.join("；")}。原数据已保留。`;
      publish();
      return Promise.resolve(false);
    }

    const types = currentTypes().filter(type => type.id !== id);
    const nextSelectedTypeId = selectedTypeId === id
      ? [...currentTypes()].sort((left, right) => left.order - right.order).find(type => type.id !== id && type.status === "active")?.id ?? null
      : selectedTypeId;
    if (!groups.get(id)?.fields.length) return saveTemplates(types, nextSelectedTypeId);
    if (snapshot.dirty || snapshot.saving) return Promise.resolve(false);
    // Remove dependent fields durably before dropping their owner from the catalog.
    pendingRemoval = id;
    return mutateGroup(id, {fields: []}, nextSelectedTypeId);
  }

  function createAsset(input: CreateAssetInput): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    if (!isRecord(input) || !keysMatch(input, ["description", "id", "name", "typeId"], ["color", "values"])) {
      localError = "资产输入字段不完整或包含未知字段。";
      publish();
      return Promise.resolve(false);
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description = input.description;
    const typeId = input.typeId;
    if (!isUuid(input.id) || !name || typeof description !== "string"
      || typeId !== null && (!isUuid(typeId) || !currentTypes().some(type => type.id === typeId))) {
      localError = "资产需要有效 UUID、名称、文本说明和已存在的类型或空类型。";
      publish();
      return Promise.resolve(false);
    }
    let color: string | undefined;
    if (input.color !== undefined && input.color !== null) {
      const normalizedColor = normalizeAssetColor(input.color);
      if (!normalizedColor) {
        localError = "资产颜色必须是 #RRGGBB 格式。";
        publish();
        return Promise.resolve(false);
      }
      color = normalizedColor;
    }
    if (hasOwn(input, "values") && !isRecord(input.values)) {
      localError = "资产属性值必须是对象。";
      publish();
      return Promise.resolve(false);
    }

    const group = groups.get(typeId) ?? emptyGroup;
    const values: Record<string, AssetPropertyValue> = {};
    if (typeId !== null) {
      for (const field of group.fields) {
        if (field.owner.kind === "type" && field.owner.id === typeId && field.status === "active" && hasOwn(field, "defaultValue")) {
          values[field.id] = clonePropertyValue(field.defaultValue!);
        }
      }
    }
    if (input.values) {
      for (const [fieldId, value] of Object.entries(input.values)) values[fieldId] = value;
    }
    const asset = freezeAsset({id: input.id, name, description, typeId, ...(color !== undefined ? {color} : {}), values});
    const existing = schema.assets.find(candidate => candidate.id === input.id);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(asset)) return settleNoop();
      if (!pendingAssetIds.has(input.id) || existing.typeId !== typeId) {
        localError = "资产 ID 已被其他资产使用。";
        publish();
        return Promise.resolve(false);
      }
      const assets = [...group.assets];
      assets[assets.findIndex(candidate => candidate.id === input.id)] = asset;
      return mutateGroup(typeId, {assets}, selectedTypeId, input.id);
    }
    return mutateGroup(typeId, {assets: [...group.assets, asset]}, selectedTypeId, asset.id);
  }

  function updateAsset(id: string, patch: Readonly<{name?: string; description?: string; color?: string | null; values?: Readonly<Record<string, AssetPropertyValue>>}>): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    if (!isRecord(patch) || Object.keys(patch).some(key => !["color", "description", "name", "values"].includes(key))) {
      localError = "资产修改内容包含未知字段。";
      publish();
      return Promise.resolve(false);
    }
    const index = schema.assets.findIndex(asset => asset.id === id);
    if (index < 0) return Promise.resolve(false);
    const current = schema.assets[index];
    const name = patch.name === undefined ? current.name : typeof patch.name === "string" ? patch.name.trim() : "";
    const description = patch.description === undefined ? current.description : patch.description;
    if (!name || typeof description !== "string") {
      localError = "资产名称不能为空，说明必须是文本。";
      publish();
      return Promise.resolve(false);
    }
    let color = current.color;
    if (patch.color === null) {
      color = undefined;
    } else if (patch.color !== undefined) {
      const normalizedColor = normalizeAssetColor(patch.color);
      if (!normalizedColor) {
        localError = "资产颜色必须是 #RRGGBB 格式。";
        publish();
        return Promise.resolve(false);
      }
      color = normalizedColor;
    }
    if (patch.values !== undefined && !isRecord(patch.values)) {
      localError = "资产属性值必须是对象。";
      publish();
      return Promise.resolve(false);
    }
    const values: Record<string, AssetPropertyValue> = {...current.values};
    if (patch.values) {
      for (const [fieldId, value] of Object.entries(patch.values)) values[fieldId] = value;
    }
    const next = freezeAsset({id: current.id, name, description, typeId: current.typeId,
      ...(color !== undefined ? {color} : {}), values});
    if (JSON.stringify(current) === JSON.stringify(next)) return settleNoop();
    const assets = groups.get(current.typeId)!.assets.map(asset => asset.id === id ? next : asset);
    return mutateGroup(current.typeId, {assets});
  }

  function removeAsset(id: string): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    const target = schema.assets.find(asset => asset.id === id);
    if (!target) return settleNoop();

    const referenceFields = new Map(schema.fields.filter(field => field.valueType === "reference").map(field => [field.id, field]));
    const blockers = schema.assets.filter(asset => asset.id !== id && Object.entries(asset.values).some(([fieldId, value]) => {
      return value === id && referenceFields.has(fieldId);
    }));
    if (blockers.length > 0) {
      localError = `无法删除资产“${target.name}”：${blockers.map(asset => `“${asset.name}”`).join("、")} 的关联属性仍引用它，请先解除关联。`;
      publish();
      return Promise.resolve(false);
    }

    const group = groups.get(target.typeId)!;
    const assets = group.assets.filter(asset => asset.id !== id);
    const fields = group.fields.filter(field => field.owner.kind !== "asset" || field.owner.id !== id);
    const nextSelectedAssetId = selectedAssetId === id ? schema.assets.find(asset => asset.id !== id)?.id ?? null : selectedAssetId;
    return mutateGroup(target.typeId, {fields, assets}, selectedTypeId, nextSelectedAssetId);
  }

  function updateType(id: string, patch: Readonly<{name?: string; description?: string; color?: string | null}>): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    if (!isRecord(patch)) {
      localError = "资产类型修改内容无效。";
      publish();
      return Promise.resolve(false);
    }
    const index = currentTypes().findIndex(type => type.id === id);
    if (index < 0) return Promise.resolve(false);
    const current = currentTypes()[index];
    const name = patch.name === undefined ? current.name : typeof patch.name === "string" ? patch.name.trim() : "";
    const description = patch.description === undefined ? current.description : patch.description;
    const color = patch.color === undefined ? current.color : patch.color === null ? undefined : normalizeAssetColor(patch.color);
    if (color === null) {
      localError = "资产模板颜色必须是 #RRGGBB 格式。";
      publish();
      return Promise.resolve(false);
    }
    if (!name || typeof description !== "string") {
      localError = "资产类型名称不能为空，说明必须是文本。";
      publish();
      return Promise.resolve(false);
    }
    if (current.status === "active" && currentTypes().some(type => type.id !== id && type.status === "active"
      && type.name.toLowerCase() === name.toLowerCase())) {
      localError = "已存在同名的启用类型。";
      publish();
      return Promise.resolve(false);
    }
    if (current.name === name && current.description === description && current.color === color) return settleNoop();
    const types = [...currentTypes()];
    const {color: _previousColor, ...rest} = current;
    types[index] = Object.freeze({...rest, name, description, ...(color !== undefined ? {color} : {})});
    return saveTemplates(types, selectedTypeId, {id, isNew: pendingTemplateEdit?.id === id && pendingTemplateEdit.isNew});
  }

  function moveType(id: string, direction: -1 | 1): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || snapshot.orderBlocked || mutating
      || (snapshot.saving || snapshot.dirty) && !snapshot.reordering) return Promise.resolve(false);
    const types = [...currentTypes()].sort((a, b) => a.order - b.order);
    const index = types.findIndex(type => type.id === id && type.status === "active");
    if (index < 0 || direction !== -1 && direction !== 1) return Promise.resolve(false);
    let target = index + direction;
    while (types[target]?.status === "archived") target += direction;
    if (!types[target]) return settleNoop();
    [types[index], types[target]] = [types[target], types[index]];
    moving++;
    localError = null;
    return templateStore.save(types.map((type, order) => ({...type, order}))).finally(() => { moving--; publish(); });
  }

  function createField(input: CreateAssetFieldInput): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    if (!isRecord(input) || !isRecord(input.owner) || !isRecord(input.config)
      || !keysMatch(input.owner, ["id", "kind"]) || !keysMatch(input.config, [], CONFIG_FIELDS)
      || !isUuid(input.id) || !["type", "asset"].includes(input.owner.kind as string) || !isUuid(input.owner.id)
      || input.owner.kind === "type" && !currentTypes().some(type => type.id === input.owner.id)
      || input.owner.kind === "asset" && !schema.assets.some(asset => asset.id === input.owner.id)) {
      localError = "资产字段需要有效 UUID 和已存在的所属类型或资产。";
      publish();
      return Promise.resolve(false);
    }
    const existing = schema.fields.find(field => field.id === input.id);
    const groupId = groupForOwner(existing?.owner ?? input.owner);
    const group = groups.get(groupId) ?? emptyGroup;
    if (existing) {
      let same = false;
      try { same = sameFieldInput(existing, input); }
      catch { same = false; }
      if (!same && pendingFieldIds.has(input.id)) {
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const replacement = {
          id: existing.id,
          owner: existing.owner,
          title,
          valueType: input.valueType,
          config: input.config,
          ...(input.defaultValue !== undefined ? {defaultValue: input.defaultValue} : {}),
          order: existing.order,
          status: existing.status,
        };
        const fields = [...group.fields];
        fields[fields.findIndex(field => field.id === input.id)] = replacement as AssetFieldDefinition;
        const assets = group.assets.map(asset => {
          if (existing.owner.kind !== "asset" || existing.owner.id !== asset.id) return asset;
          const values: Record<string, AssetPropertyValue> = {...asset.values};
          if (hasOwn(existing, "defaultValue")
            && hasOwn(values, existing.id) && JSON.stringify(values[existing.id]) === JSON.stringify(existing.defaultValue)) {
            delete values[existing.id];
          }
          if (replacement.defaultValue !== undefined
            && !hasOwn(values, replacement.id)) values[replacement.id] = clonePropertyValue(replacement.defaultValue);
          return freezeAsset({...asset, values});
        });
        return mutateGroup(groupId, {fields, assets});
      }
      if (!same) {
        localError = "字段 ID 已被其他字段使用。";
        publish();
        return Promise.resolve(false);
      }
      return settleNoop();
    }
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      localError = "资产字段标题不能为空。";
      publish();
      return Promise.resolve(false);
    }
    if (group.fields.some(field => field.owner.kind === input.owner.kind && field.owner.id === input.owner.id && field.status === "active"
      && field.title.toLowerCase() === title.toLowerCase())) {
      localError = "同一对象中已存在同名的启用字段。";
      publish();
      return Promise.resolve(false);
    }
    const ownerFields = group.fields.filter(field => field.owner.kind === input.owner.kind && field.owner.id === input.owner.id);
    const order = ownerFields.reduce((maximum, field) => Math.max(maximum, field.order), -1) + 1;
    const candidate: AssetFieldDefinition = Object.freeze({
      id: input.id,
      owner: Object.freeze({kind: input.owner.kind as "type" | "asset", id: input.owner.id}),
      title,
      valueType: input.valueType,
      config: input.config,
      ...(input.defaultValue !== undefined ? {defaultValue: cloneDefault(input.defaultValue)} : {}),
      order,
      status: "active",
    });
    const fields = [...group.fields, candidate];
    if (candidate.owner.kind === "asset" && hasOwn(candidate, "defaultValue")) {
      const assets = group.assets.map(asset => asset.id === candidate.owner.id
        ? freezeAsset({...asset, values: {...asset.values, [candidate.id]: clonePropertyValue(candidate.defaultValue!)}})
        : asset);
      return mutateGroup(groupId, {fields, assets});
    }
    return mutateGroup(groupId, {fields});
  }

  function renameField(id: string, title: string): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    const index = schema.fields.findIndex(field => field.id === id);
    if (index < 0) return Promise.resolve(false);
    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    if (!normalizedTitle) {
      localError = "资产字段标题不能为空。";
      publish();
      return Promise.resolve(false);
    }
    const current = schema.fields[index];
    if (current.status === "active" && schema.fields.some(field => field.id !== id && field.owner.kind === current.owner.kind && field.owner.id === current.owner.id
      && field.status === "active" && field.title.toLowerCase() === normalizedTitle.toLowerCase())) {
      localError = "同一对象中已存在同名的启用字段。";
      publish();
      return Promise.resolve(false);
    }
    if (current.title === normalizedTitle) return settleNoop();
    const groupId = groupForOwner(current.owner);
    const fields = groups.get(groupId)!.fields.map(field => field.id === id ? Object.freeze({...field, title: normalizedTitle}) : field);
    return mutateGroup(groupId, {fields});
  }

  function removeAssetField(assetId: string, fieldId: string): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    const assetIndex = schema.assets.findIndex(asset => asset.id === assetId);
    if (assetIndex < 0) {
      localError = "无法删除专属属性：所属资产不存在。";
      publish();
      return Promise.resolve(false);
    }
    const field = schema.fields.find(candidate => candidate.id === fieldId);
    if (!field) return settleNoop();
    if (field.owner.kind !== "asset" || field.owner.id !== assetId) {
      localError = "无法删除专属属性：该字段不属于指定资产。";
      publish();
      return Promise.resolve(false);
    }

    const asset = schema.assets[assetIndex];
    const group = groups.get(asset.typeId)!;
    const fields = group.fields.filter(candidate => candidate.id !== fieldId);
    const values: Record<string, AssetPropertyValue> = {...asset.values};
    delete values[fieldId];
    const assets = group.assets.map(item => item.id === assetId ? freezeAsset({...asset, values}) : item);
    return mutateGroup(asset.typeId, {fields, assets});
  }

  function moveField(id: string, direction: -1 | 1): Promise<boolean> {
    if (!canEdit()) return Promise.resolve(false);
    const current = schema.fields.find(field => field.id === id);
    if (!current) return Promise.resolve(false);
    const groupId = groupForOwner(current.owner);
    const group = groups.get(groupId)!;
    const ownerFields = group.fields.filter(field => field.owner.kind === current.owner.kind && field.owner.id === current.owner.id).sort((a, b) => a.order - b.order);
    const index = ownerFields.findIndex(field => field.id === id);
    const target = index + direction;
    if (target < 0 || target >= ownerFields.length) return settleNoop();
    [ownerFields[index], ownerFields[target]] = [ownerFields[target], ownerFields[index]];
    const normalized = ownerFields.map((field, order) => Object.freeze({...field, order}));
    const byId = new Map(normalized.map(field => [field.id, field]));
    const fields = group.fields.map(field => byId.get(field.id) ?? field);
    return mutateGroup(groupId, {fields});
  }

  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (loading) return loadOperation ?? false;
    if (mutating) return mutationOperation ?? false;
    if (files.getSnapshot().blocked) return false;
    if (!loaded || snapshot.blocked || legacyOrderError) {
      // Reload repaired files without discarding a body edit that storage has not accepted.
      if (pendingGroup) {
        if (!await loadTemplates() || snapshot.blocked || legacyOrderError) return false;
      } else if (!await load() || snapshot.orderBlocked || snapshot.blocked) {
        return false;
      }
    }
    const catalog = templateStore.getSnapshot();
    if (catalog.dirty || catalog.saving || catalog.blocked || !catalog.loaded) {
      if (!await templateStore.retry()) return false;
      pendingTemplateEdit = null;
    }
    if (pendingGroup) {
      localError = null;
      return persistMutation();
    }
    for (const file of dataFiles()) {
      if (!file.dirty && file.saveState === "saved") continue;
      if (!await files.save(file.path)) return false;
    }
    return finishPendingRemoval();
  }

  return Object.freeze({
    getSnapshot() { return snapshot; },
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    selectType,
    requestTypeCreation,
    selectAsset,
    createType,
    removeType,
    createAsset,
    updateAsset,
    removeAsset,
    updateType,
    moveType,
    createField,
    renameField,
    removeAssetField,
    moveField,
    retry,
    async dispose() {
      if (!alive) return;
      alive = false;
      generation++;
      unsubscribeTemplates();
      const finishingTemplates = templateStore.dispose();
      objectFiles.dispose();
      unsubscribe();
      listeners.clear();
      parsedBytes = null;
      document = {};
      schemaBytes = null;
      loading = false;
      mutating = false;
      snapshot = Object.freeze({...snapshot, loading: false, saving: false, reordering: false, blocked: true});
      await finishingTemplates;
    },
  });
}
