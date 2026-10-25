import type {ProjectFile, ProjectFileBytes, ProjectFiles, ProjectSaveState} from "@lodestory/sdk/project-storage";

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
  updateType(id: string, patch: Readonly<{name?: string; description?: string}>): Promise<boolean>;
  moveType(id: string, direction: -1 | 1): Promise<boolean>;
  createField(input: CreateAssetFieldInput): Promise<boolean>;
  renameField(id: string, title: string): Promise<boolean>;
  removeAssetField(assetId: string, fieldId: string): Promise<boolean>;
  moveField(id: string, direction: -1 | 1): Promise<boolean>;
  retry(): Promise<boolean>;
  dispose(): void;
}>;

const PATH = ".lodestory/assets/schema.json";
const DIRECTORY = ".lodestory/assets";
const FORMAT = "lodestory.asset-schema";
const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TYPE_NAME = 60;
const MAX_TYPE_DESCRIPTION = 200;
const MAX_FIELD_TITLE = 60;
const MAX_ASSET_NAME = 60;
const MAX_ASSET_DESCRIPTION = 200;
const ASSET_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 100;
const TYPE_FIELDS = ["description", "id", "name", "order", "status"];
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

function encodeUtf8(value: string): ProjectFileBytes {
  return Object.freeze(Array.from(new TextEncoder().encode(value)));
}

function decodeUtf8(bytes: ProjectFileBytes): string {
  return new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(bytes));
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
  return Object.freeze({types: Object.freeze([...types]), assets: Object.freeze(assets.map(freezeAsset)), fields: Object.freeze([...fields])});
}

function orderIsValid(order: unknown): order is number {
  return typeof order === "number" && Number.isSafeInteger(order) && order >= 0;
}

function normalizeSchema(value: unknown): {schema: SchemaData | null; error: string | null} {
  if (!isRecord(value)) {
    return {schema: null, error: "类型模板文件字段不完整或包含未知字段，已保留原始文件。"};
  }
  const version = value.schemaVersion;
  if (value.format !== FORMAT || version !== LEGACY_SCHEMA_VERSION && version !== SCHEMA_VERSION) {
    return {schema: null, error: "类型模板文件格式或版本不受支持，已保留原始文件。"};
  }
  const expectedDocumentFields = version === LEGACY_SCHEMA_VERSION ? LEGACY_DOCUMENT_FIELDS : DOCUMENT_FIELDS;
  if (!keysMatch(value, expectedDocumentFields)) {
    return {schema: null, error: "类型模板文件字段不完整或包含未知字段，已保留原始文件。"};
  }
  if (!Array.isArray(value.types) || !Array.isArray(value.fields) || version === SCHEMA_VERSION && !Array.isArray(value.assets)) {
    return {schema: null, error: "资产类型和字段定义必须是数组，已保留原始文件。"};
  }

  const types: AssetTypeTemplate[] = [];
  const typeIds = new Set<string>();
  const globalIds = new Set<string>();
  const typeOrders = new Set<number>();
  const activeTypeNames = new Set<string>();
  for (const candidate of value.types) {
    if (!isRecord(candidate) || !keysMatch(candidate, TYPE_FIELDS)) {
      return {schema: null, error: "资产类型定义字段不完整或包含未知字段，已保留原始文件。"};
    }
    if (!isUuid(candidate.id) || !orderIsValid(candidate.order)) {
      return {schema: null, error: "资产类型 ID 必须是 UUID，顺序必须是非负整数，已保留原始文件。"};
    }
    if (typeIds.has(candidate.id) || globalIds.has(candidate.id)) {
      return {schema: null, error: "资产类型 ID 重复，已保留原始文件。"};
    }
    if (typeOrders.has(candidate.order)) return {schema: null, error: "资产类型顺序重复，已保留原始文件。"};
    if (typeof candidate.name !== "string" || [...candidate.name.trim()].length < 1 || [...candidate.name.trim()].length > MAX_TYPE_NAME) {
      return {schema: null, error: `资产类型名称需为 trim 后 1 到 ${MAX_TYPE_NAME} 个字符，已保留原始文件。`};
    }
    if (typeof candidate.description !== "string" || [...candidate.description].length > MAX_TYPE_DESCRIPTION) {
      return {schema: null, error: `资产类型说明必须是文本且最多 ${MAX_TYPE_DESCRIPTION} 个字符，已保留原始文件。`};
    }
    if (candidate.status !== "active" && candidate.status !== "archived") {
      return {schema: null, error: "资产类型状态无效，已保留原始文件。"};
    }
    const name = candidate.name.trim();
    const nameKey = name.toLowerCase();
    if (candidate.status === "active" && activeTypeNames.has(nameKey)) {
      return {schema: null, error: "启用中的资产类型名称重复，已保留原始文件。"};
    }
    typeIds.add(candidate.id);
    globalIds.add(candidate.id);
    typeOrders.add(candidate.order);
    if (candidate.status === "active") activeTypeNames.add(nameKey);
    types.push(Object.freeze({id: candidate.id, name, description: candidate.description, order: candidate.order, status: candidate.status}));
  }

  const rawAssets: {id: string; name: string; description: string; typeId: string | null; color?: string; values: Record<string, unknown>}[] = [];
  const assetIds = new Set<string>();
  for (const candidate of version === SCHEMA_VERSION ? value.assets as unknown[] : []) {
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
      || candidate.owner.kind === "asset" && (version === LEGACY_SCHEMA_VERSION || !assetIds.has(candidate.owner.id))) {
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
  const assetById = new Map(rawAssets.map(asset => [asset.id, {id: asset.id, typeId: asset.typeId}]));
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

function parseSchema(bytes: ProjectFileBytes): {schema: SchemaData | null; error: string | null} {
  let text: string;
  try { text = decodeUtf8(bytes); }
  catch { return {schema: null, error: "类型模板文件不是有效 UTF-8，已保留原始文件。"}; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return {schema: null, error: "类型模板文件已损坏，已保留原始文件。"}; }
  return normalizeSchema(value);
}

function serializeSchema(schema: SchemaData): ProjectFileBytes {
  return encodeUtf8(`${JSON.stringify({format: FORMAT, schemaVersion: SCHEMA_VERSION, types: schema.types, assets: schema.assets, fields: schema.fields}, null, 2)}\n`);
}

function sameSchema(left: SchemaData, right: SchemaData): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const pendingTypeIds = new Set<string>();
  const pendingAssetIds = new Set<string>();
  const pendingFieldIds = new Set<string>();
  let loaded = false;
  let loading = false;
  let mutating = false;
  let knownFile = false;
  let localDraft = false;
  let localBlocked = false;
  let localError: string | null = null;
  let alive = true;
  let generation = 0;
  let loadOperation: Promise<boolean> | null = null;
  let mutationOperation: Promise<boolean> | null = null;
  let snapshot = buildSnapshot(files.getSnapshot());

  function fileFrom(sourceFiles = files.getSnapshot().files): ProjectFile | undefined {
    return sourceFiles.find(file => file.path === PATH);
  }

  function buildSnapshot(source = files.getSnapshot()): AssetSchemaSnapshot {
    const file = fileFrom(source.files);
    const dirty = localDraft || Boolean(file?.dirty);
    const saveState: ProjectSaveState = mutating ? "saving"
      : dirty ? (localError || file?.saveState === "error" ? "error" : "pending")
        : file?.saveState ?? "saved";
    return Object.freeze({
      types: schema.types,
      assets: schema.assets,
      fields: schema.fields,
      selectedTypeId,
      selectedAssetId,
      typeCreationRequest,
      loaded,
      loading,
      saving: loading || mutating || saveState === "pending" || saveState === "saving",
      dirty,
      blocked: source.blocked || localBlocked,
      error: localError ?? file?.saveError ?? (saveState === "error" ? "类型模板保存失败，请重试。" : null),
      saveState,
    });
  }

  function publish() {
    if (!alive) return;
    snapshot = buildSnapshot();
    for (const listener of [...listeners]) listener();
  }

  function clearPendingIds() {
    pendingTypeIds.clear();
    pendingAssetIds.clear();
    pendingFieldIds.clear();
  }

  function reconcileTypeSelection() {
    const firstActiveId = [...schema.types].sort((left, right) => left.order - right.order).find(type => type.status === "active")?.id ?? null;
    if (!typeSelectionInitialized) {
      selectedTypeId = firstActiveId;
      typeSelectionInitialized = true;
    } else if (selectedTypeId !== null && !schema.types.some(type => type.id === selectedTypeId)) {
      selectedTypeId = firstActiveId;
    }
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
    const parsed = parseSchema(file.bytes);
    if (!alive || requestGeneration !== undefined && requestGeneration !== generation) return false;
    if (!parsed.schema) {
      loaded = false;
      localBlocked = true;
      localError = parsed.error;
      return false;
    }
    if (!sameSchema(schema, parsed.schema)) schema = parsed.schema;
    reconcileTypeSelection();
    reconcileAssetSelection();
    knownFile = true;
    localDraft = false;
    if (!file.dirty && file.saveState === "saved") clearPendingIds();
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
      // Shared ProjectFiles bytes are canonical once accepted; don't replace a local draft
      // that has not yet been accepted by the byte store.
      if (!localDraft) {
        const parsed = parseSchema(sharedFile.bytes);
        if (parsed.schema) {
          if (!sameSchema(schema, parsed.schema)) schema = parsed.schema;
          reconcileTypeSelection();
          reconcileAssetSelection();
          loaded = true;
          if (!sharedFile.dirty && sharedFile.saveState === "saved") clearPendingIds();
          localBlocked = false;
          localError = null;
        } else if (loaded) {
          loaded = false;
          localBlocked = true;
          localError = parsed.error;
        }
      }
    } else if (knownFile && !localDraft) {
      knownFile = false;
    }
    publish();
  });

  function load(): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    if (loaded && !localBlocked) return Promise.resolve(true);
    if (loadOperation) return loadOperation;
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
          const valid = acceptFile(protectedFile, requestGeneration);
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
          schema = freezeSchema([], [], []);
          selectedTypeId = null;
          typeSelectionInitialized = true;
          selectedAssetId = null;
          assetSelectionInitialized = true;
          loaded = true;
          knownFile = false;
          localDraft = false;
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
        try { readOperation = files.read(PATH); }
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
        if (retainedFile && (retainedFile.dirty || retainedFile.saveState === "saving" || retainedFile.saveState === "pending")) {
          const valid = acceptFile(retainedFile, requestGeneration);
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
    if (!alive || files.getSnapshot().blocked || localBlocked) return false;
    const bytes = serializeSchema(schema);
    if (!knownFile && !fileFrom()) {
      if (schema.types.length === 0 && schema.assets.length === 0 && schema.fields.length === 0) {
        localDraft = false;
        localError = null;
        publish();
        return true;
      }
      let created: ProjectFile | null = null;
      try { created = await files.create(PATH, bytes, {createParents: true, acceptIdentical: true}); }
      catch (cause) { localError = cause instanceof Error ? cause.message : "创建类型模板文件失败，请重试。"; }
      if (!alive) return false;
      if (!created) {
        localError ??= files.getSnapshot().error ?? "创建类型模板文件失败，请重试。";
        return false;
      }
      return acceptFile(created);
    }

    localDraft = true;
    let accepted = false;
    try { accepted = files.write(PATH, bytes); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "更新类型模板失败。"; }
    if (!accepted) {
      localError ??= files.getSnapshot().blocked ? files.getSnapshot().error : "项目存储未接受类型模板。";
      return false;
    }
    localDraft = false;
    knownFile = true;
    publish();
    let saved = false;
    try { saved = await files.save(PATH); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "保存类型模板失败，请重试。"; }
    if (!alive) return false;
    localError = saved ? null : fileFrom()?.saveError ?? (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "保存类型模板失败，请重试。";
    return saved;
  }

  function mutate(nextSchema: SchemaData, nextSelectedTypeId = selectedTypeId, nextSelectedAssetId = selectedAssetId): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    const checked = normalizeSchema({format: FORMAT, schemaVersion: SCHEMA_VERSION, types: nextSchema.types, assets: nextSchema.assets, fields: nextSchema.fields});
    if (!checked.schema) {
      localError = checked.error?.replace(/ 已保留原始文件。$/, "") ?? "类型模板定义无效。";
      publish();
      return Promise.resolve(false);
    }
    const validatedSchema = checked.schema;
    if (sameSchema(schema, validatedSchema)) {
      if (selectedTypeId !== nextSelectedTypeId || selectedAssetId !== nextSelectedAssetId) {
        selectedTypeId = nextSelectedTypeId;
        typeSelectionInitialized = true;
        selectedAssetId = nextSelectedAssetId;
        assetSelectionInitialized = true;
        publish();
        return Promise.resolve(true);
      }
      return settleNoop();
    }
    const previousTypeIds = new Set(schema.types.map(type => type.id));
    const previousAssetIds = new Set(schema.assets.map(asset => asset.id));
    const previousFieldIds = new Set(schema.fields.map(field => field.id));
    for (const type of validatedSchema.types) {
      if (!previousTypeIds.has(type.id)) pendingTypeIds.add(type.id);
    }
    for (const field of validatedSchema.fields) {
      if (!previousFieldIds.has(field.id)) pendingFieldIds.add(field.id);
    }
    for (const asset of validatedSchema.assets) {
      if (!previousAssetIds.has(asset.id)) pendingAssetIds.add(asset.id);
    }
    schema = validatedSchema;
    selectedTypeId = nextSelectedTypeId;
    typeSelectionInitialized = true;
    selectedAssetId = nextSelectedAssetId && schema.assets.some(asset => asset.id === nextSelectedAssetId) ? nextSelectedAssetId : null;
    assetSelectionInitialized = true;
    localDraft = true;
    localError = null;
    mutating = true;
    let resolveOperation!: (value: boolean) => void;
    const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
    mutationOperation = operation;
    publish();
    void persistCurrent().catch(cause => {
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
    if (snapshot.dirty || localDraft || file?.saveState === "pending" || file?.saveState === "saving" || file?.saveState === "error") {
      return retry();
    }
    if (localError) {
      localError = null;
      publish();
    }
    return Promise.resolve(true);
  }

  function currentSchemaWith(types: readonly AssetTypeTemplate[], fields: readonly AssetFieldDefinition[] = schema.fields): SchemaData {
    return freezeSchema(types, fields, schema.assets);
  }

  function selectType(id: string | null): boolean {
    if (!alive || id !== null && !schema.types.some(type => type.id === id)) return false;
    typeSelectionInitialized = true;
    if (selectedTypeId !== id) {
      selectedTypeId = id;
      publish();
    }
    return true;
  }

  function requestTypeCreation(): boolean {
    if (!alive || !loaded || snapshot.blocked || snapshot.saving || snapshot.dirty) return false;
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

  function createType(input: CreateAssetTypeInput): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    if (!isRecord(input)) {
      localError = "资产类型输入格式无效。";
      publish();
      return Promise.resolve(false);
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!isUuid(input.id) || !name || typeof input.description !== "string") {
      localError = "资产类型需要有效 UUID、名称和文本说明。";
      publish();
      return Promise.resolve(false);
    }
    const existing = schema.types.find(type => type.id === input.id);
    if (existing) {
      if (existing.name !== name || existing.description !== input.description) {
        if (pendingTypeIds.has(input.id)) return updateType(input.id, {name, description: input.description});
        localError = "资产类型 ID 已被其他类型使用。";
        publish();
        return Promise.resolve(false);
      }
      return settleNoop();
    }
    if (schema.types.some(type => type.status === "active" && type.name.toLowerCase() === name.toLowerCase())) {
      localError = "已存在同名的启用类型。";
      publish();
      return Promise.resolve(false);
    }
    const order = schema.types.reduce((maximum, type) => Math.max(maximum, type.order), -1) + 1;
    const type: AssetTypeTemplate = Object.freeze({id: input.id, name, description: input.description, order, status: "active"});
    return mutate(currentSchemaWith([...schema.types, type]), type.id);
  }

  function removeType(id: string): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    const target = schema.types.find(type => type.id === id);
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
            ? schema.types.find(type => type.id === field.owner.id)?.name ?? field.owner.id
            : schema.assets.find(asset => asset.id === field.owner.id)?.name ?? field.owner.id;
          return `“${field.title}”（${ownerName}）`;
        });
        reasons.push(`以下字段仍以此类型为关联目标：${names.join("、")}`);
      }
      localError = `无法删除类型“${target.name}”：${reasons.join("；")}。原数据已保留。`;
      publish();
      return Promise.resolve(false);
    }

    const types = schema.types.filter(type => type.id !== id);
    const fields = schema.fields.filter(field => field.owner.kind !== "type" || field.owner.id !== id);
    const nextSelectedTypeId = selectedTypeId === id
      ? [...types].sort((left, right) => left.order - right.order).find(type => type.status === "active")?.id ?? null
      : selectedTypeId;
    return mutate(freezeSchema(types, fields, schema.assets), nextSelectedTypeId);
  }

  function createAsset(input: CreateAssetInput): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    if (!isRecord(input) || !keysMatch(input, ["description", "id", "name", "typeId"], ["color", "values"])) {
      localError = "资产输入字段不完整或包含未知字段。";
      publish();
      return Promise.resolve(false);
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description = input.description;
    const typeId = input.typeId;
    if (!isUuid(input.id) || !name || typeof description !== "string"
      || typeId !== null && (!isUuid(typeId) || !schema.types.some(type => type.id === typeId))) {
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

    const values: Record<string, AssetPropertyValue> = {};
    if (typeId !== null) {
      for (const field of schema.fields) {
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
      if (!pendingAssetIds.has(input.id)) {
        localError = "资产 ID 已被其他资产使用。";
        publish();
        return Promise.resolve(false);
      }
      const assets = [...schema.assets];
      assets[assets.findIndex(candidate => candidate.id === input.id)] = asset;
      return mutate(freezeSchema(schema.types, schema.fields, assets), selectedTypeId, input.id);
    }
    return mutate(freezeSchema(schema.types, schema.fields, [...schema.assets, asset]), selectedTypeId, asset.id);
  }

  function updateAsset(id: string, patch: Readonly<{name?: string; description?: string; color?: string | null; values?: Readonly<Record<string, AssetPropertyValue>>}>): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
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
    const assets = [...schema.assets];
    assets[index] = next;
    return mutate(freezeSchema(schema.types, schema.fields, assets));
  }

  function removeAsset(id: string): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
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

    const assets = schema.assets.filter(asset => asset.id !== id);
    const fields = schema.fields.filter(field => field.owner.kind !== "asset" || field.owner.id !== id);
    const nextSelectedAssetId = selectedAssetId === id ? assets[0]?.id ?? null : selectedAssetId;
    return mutate(freezeSchema(schema.types, fields, assets), selectedTypeId, nextSelectedAssetId);
  }

  function updateType(id: string, patch: Readonly<{name?: string; description?: string}>): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    if (!isRecord(patch)) {
      localError = "资产类型修改内容无效。";
      publish();
      return Promise.resolve(false);
    }
    const index = schema.types.findIndex(type => type.id === id);
    if (index < 0) return Promise.resolve(false);
    const current = schema.types[index];
    const name = patch.name === undefined ? current.name : typeof patch.name === "string" ? patch.name.trim() : "";
    const description = patch.description === undefined ? current.description : patch.description;
    if (!name || typeof description !== "string") {
      localError = "资产类型名称不能为空，说明必须是文本。";
      publish();
      return Promise.resolve(false);
    }
    if (current.status === "active" && schema.types.some(type => type.id !== id && type.status === "active"
      && type.name.toLowerCase() === name.toLowerCase())) {
      localError = "已存在同名的启用类型。";
      publish();
      return Promise.resolve(false);
    }
    if (current.name === name && current.description === description) return settleNoop();
    const types = [...schema.types];
    types[index] = Object.freeze({...current, name, description});
    return mutate(currentSchemaWith(types));
  }

  function moveType(id: string, direction: -1 | 1): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    const types = [...schema.types].sort((a, b) => a.order - b.order);
    const index = types.findIndex(type => type.id === id);
    const target = index + direction;
    if (index < 0) return Promise.resolve(false);
    if (target < 0 || target >= types.length) return settleNoop();
    [types[index], types[target]] = [types[target], types[index]];
    const ordered = types.map((type, order) => Object.freeze({...type, order}));
    return mutate(currentSchemaWith(ordered));
  }

  function createField(input: CreateAssetFieldInput): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    if (!isRecord(input) || !isRecord(input.owner) || !isRecord(input.config)
      || !keysMatch(input.owner, ["id", "kind"]) || !keysMatch(input.config, [], CONFIG_FIELDS)
      || !isUuid(input.id) || !["type", "asset"].includes(input.owner.kind as string) || !isUuid(input.owner.id)
      || input.owner.kind === "type" && !schema.types.some(type => type.id === input.owner.id)
      || input.owner.kind === "asset" && !schema.assets.some(asset => asset.id === input.owner.id)) {
      localError = "资产字段需要有效 UUID 和已存在的所属类型或资产。";
      publish();
      return Promise.resolve(false);
    }
    const existing = schema.fields.find(field => field.id === input.id);
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
        const fields = [...schema.fields];
        fields[fields.findIndex(field => field.id === input.id)] = replacement as AssetFieldDefinition;
        const assets = schema.assets.map(asset => {
          const values: Record<string, AssetPropertyValue> = {...asset.values};
          if (existing.owner.kind === "asset" && existing.owner.id === asset.id && hasOwn(existing, "defaultValue")
            && hasOwn(values, existing.id) && JSON.stringify(values[existing.id]) === JSON.stringify(existing.defaultValue)) {
            delete values[existing.id];
          }
          if (replacement.owner.kind === "asset" && replacement.owner.id === asset.id && replacement.defaultValue !== undefined
            && !hasOwn(values, replacement.id)) values[replacement.id] = clonePropertyValue(replacement.defaultValue);
          return freezeAsset({...asset, values});
        });
        return mutate(freezeSchema(schema.types, fields, assets));
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
    if (schema.fields.some(field => field.owner.kind === input.owner.kind && field.owner.id === input.owner.id && field.status === "active"
      && field.title.toLowerCase() === title.toLowerCase())) {
      localError = "同一对象中已存在同名的启用字段。";
      publish();
      return Promise.resolve(false);
    }
    const ownerFields = schema.fields.filter(field => field.owner.kind === input.owner.kind && field.owner.id === input.owner.id);
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
    const checked = normalizeSchema({format: FORMAT, schemaVersion: SCHEMA_VERSION, types: schema.types, assets: schema.assets, fields: [...schema.fields, candidate]});
    if (!checked.schema) {
      localError = checked.error?.replace(/ 已保留原始文件。$/, "") ?? "资产字段定义无效。";
      publish();
      return Promise.resolve(false);
    }
    if (candidate.owner.kind === "asset" && hasOwn(candidate, "defaultValue")) {
      const assets = checked.schema.assets.map(asset => asset.id === candidate.owner.id
        ? freezeAsset({...asset, values: {...asset.values, [candidate.id]: clonePropertyValue(candidate.defaultValue!)}})
        : asset);
      return mutate(freezeSchema(checked.schema.types, checked.schema.fields, assets));
    }
    return mutate(checked.schema);
  }

  function renameField(id: string, title: string): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
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
    const fields = [...schema.fields];
    fields[index] = Object.freeze({...current, title: normalizedTitle});
    return mutate(currentSchemaWith(schema.types, fields));
  }

  function removeAssetField(assetId: string, fieldId: string): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
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

    const fields = schema.fields.filter(candidate => candidate.id !== fieldId);
    const assets = [...schema.assets];
    const asset = assets[assetIndex];
    const values: Record<string, AssetPropertyValue> = {...asset.values};
    delete values[fieldId];
    assets[assetIndex] = freezeAsset({...asset, values});
    return mutate(freezeSchema(schema.types, fields, assets));
  }

  function moveField(id: string, direction: -1 | 1): Promise<boolean> {
    if (!alive || !loaded || snapshot.blocked || mutating) return Promise.resolve(false);
    const current = schema.fields.find(field => field.id === id);
    if (!current) return Promise.resolve(false);
    const ownerFields = schema.fields.filter(field => field.owner.kind === current.owner.kind && field.owner.id === current.owner.id).sort((a, b) => a.order - b.order);
    const index = ownerFields.findIndex(field => field.id === id);
    const target = index + direction;
    if (target < 0 || target >= ownerFields.length) return settleNoop();
    [ownerFields[index], ownerFields[target]] = [ownerFields[target], ownerFields[index]];
    const normalized = ownerFields.map((field, order) => Object.freeze({...field, order}));
    const byId = new Map(normalized.map(field => [field.id, field]));
    const fields = schema.fields.map(field => byId.get(field.id) ?? field);
    return mutate(currentSchemaWith(schema.types, fields));
  }

  async function retry(): Promise<boolean> {
    if (!alive) return false;
    if (loading) return loadOperation ?? false;
    if (mutating) return mutationOperation ?? false;
    if (!loaded || localBlocked) return load();
    if (files.getSnapshot().blocked) return false;
    const file = fileFrom();
    if (localDraft) {
      mutating = true;
      localError = null;
      let resolveOperation!: (value: boolean) => void;
      const operation = new Promise<boolean>(resolve => { resolveOperation = resolve; });
      mutationOperation = operation;
      publish();
      void persistCurrent().catch(cause => {
        if (alive) localError = cause instanceof Error ? cause.message : "保存类型模板失败，请重试。";
        return false;
      }).then(result => {
        if (alive) {
          if (result) clearPendingIds();
          mutating = false;
          publish();
        }
        if (mutationOperation === operation) mutationOperation = null;
        resolveOperation(Boolean(result));
      });
      return operation;
    }
    if (!file?.dirty && file?.saveState !== "pending" && file?.saveState !== "saving" && file?.saveState !== "error") return true;
    let saved = false;
    try { saved = await files.save(PATH); }
    catch (cause) { localError = cause instanceof Error ? cause.message : "保存类型模板失败，请重试。"; }
    if (!alive) return false;
    if (saved) clearPendingIds();
    localError = saved ? null : fileFrom()?.saveError ?? (files.getSnapshot().blocked ? files.getSnapshot().error : null) ?? "保存类型模板失败，请重试。";
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
    dispose() {
      if (!alive) return;
      alive = false;
      generation++;
      unsubscribe();
      listeners.clear();
      loading = false;
      mutating = false;
      snapshot = Object.freeze({...snapshot, loading: false, saving: false, blocked: true});
    },
  });
}
