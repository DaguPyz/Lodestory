import type {AssetCatalog} from "@lodestory/sdk/asset-catalog";
import type {AssetRelation, AssetRelationEndpoint, AssetRelationNetwork, AssetRelationSnapshot} from "@lodestory/sdk/asset-relations";
import type {ProjectFiles} from "@lodestory/sdk/project-storage";

const DIRECTORY = ".lodestory/asset-relations";
const FILE_NAME = "relations.json";
const PATH = `${DIRECTORY}/${FILE_NAME}`;
const FORMAT = "lodestory.asset-relations";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY: readonly AssetRelation[] = Object.freeze([]);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("关系数据必须是对象。");
  return value as Record<string, unknown>;
}

function normalizeEndpoint(value: unknown): AssetRelationEndpoint {
  const {assetsId, tag, ...extra} = asRecord(value);
  if (typeof assetsId !== "string" || !UUID.test(assetsId) || Object.keys(extra).length > 0) {
    throw new Error("关系的一端必须引用有效的资产 ID。");
  }
  if (tag !== undefined && typeof tag !== "string") throw new Error("对象标签必须是文字。");
  const text = tag?.trim();
  return Object.freeze(text ? {assetsId, tag: text} : {assetsId});
}

function normalizeRelation(value: unknown): AssetRelation {
  const {assets, label, ...extra} = asRecord(value);
  if (!Array.isArray(assets) || assets.length !== 2 || Object.keys(extra).length > 0) {
    throw new Error("每条关系必须包含两个对象和关系描述。");
  }
  const first = normalizeEndpoint(assets[0]);
  const second = normalizeEndpoint(assets[1]);
  if (first.assetsId === second.assetsId) throw new Error("请选择另一个对象。");
  if (typeof label !== "string" || !label.trim()) throw new Error("请填写关系描述。");
  const endpoints: [AssetRelationEndpoint, AssetRelationEndpoint] = first.assetsId < second.assetsId
    ? [first, second] : [second, first];
  return Object.freeze({assets: Object.freeze(endpoints), label: label.trim()});
}

/** Order is canonical in the store. Matching the full record allows several distinct relationships per pair. */
export function relationKey(relation: AssetRelation): string {
  return JSON.stringify(relation);
}

function parseRelations(bytes: readonly number[]): readonly AssetRelation[] {
  let data: unknown;
  try {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(Uint8Array.from(bytes));
    data = JSON.parse(text);
  } catch {
    throw new Error("资产关系文件无法解析，原文件已保留。");
  }
  const {format, schemaVersion, relations, ...extra} = asRecord(data);
  if (format !== FORMAT || schemaVersion !== 1 || !Array.isArray(relations) || Object.keys(extra).length > 0) {
    throw new Error("关系文件的格式或版本无法读取。");
  }
  const entries = relations.map(normalizeRelation);
  if (new Set(entries.map(relationKey)).size !== entries.length) throw new Error("关系文件包含重复记录。");
  return Object.freeze(entries);
}

export type AssetRelationStore = AssetRelationNetwork & Readonly<{
  load(): Promise<boolean>;
  save(next: AssetRelation, previous?: AssetRelation): Promise<boolean>;
  remove(relation: AssetRelation): Promise<boolean>;
  retrySave(): Promise<boolean>;
  clearError(): void;
  dispose(): void;
}>;

export function createAssetRelationStore(files: ProjectFiles, catalog: AssetCatalog | null): AssetRelationStore {
  const listeners = new Set<() => void>();
  let relations = EMPTY;
  let relationsByAsset = new Map<string, readonly AssetRelation[]>();
  let loaded = false;
  let fileExists = false;
  let phase: "loading" | "saving" | null = null;
  let pending: readonly AssetRelation[] | null = null;
  let error: string | null = null;
  let alive = true;
  let snapshot = getState();

  function getState(): AssetRelationSnapshot {
    return Object.freeze({loaded, loading: phase === "loading", saving: phase === "saving", pending: pending !== null, error});
  }

  function publish() {
    snapshot = getState();
    for (const listener of [...listeners]) {
      try { listener(); }
      catch (cause) { console.error("Asset relations subscriber failed.", {cause}); }
    }
  }

  function setRelations(next: readonly AssetRelation[]) {
    relations = next;
    const index = new Map<string, AssetRelation[]>();
    for (const relation of relations) {
      for (const {assetsId} of relation.assets) {
        const rows = index.get(assetsId);
        if (rows) rows.push(relation);
        else index.set(assetsId, [relation]);
      }
    }
    relationsByAsset = new Map([...index].map(([assetId, rows]) => [assetId, Object.freeze(rows)]));
  }

  async function run(nextPhase: "loading" | "saving", action: () => Promise<void>): Promise<boolean> {
    if (!alive || phase) return false;
    phase = nextPhase;
    error = null;
    publish();
    try {
      if (!alive) return false;
      await action();
      return alive;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      phase = null;
      if (alive) publish();
    }
  }

  function load(): Promise<boolean> {
    if (loaded) return Promise.resolve(alive);
    return run("loading", async () => {
      const listing = await files.list(DIRECTORY);
      if (!alive) return;
      if (!listing) throw new Error(files.getSnapshot().error ?? "无法读取资产关系目录。");
      const issue = listing.issues.find(item => item.path === PATH || item.path === FILE_NAME);
      if (issue) throw new Error(issue.message);
      const entry = listing.entries.find(item => item.name === FILE_NAME);
      if (entry) {
        if (entry.kind !== "file" || entry.path !== PATH) throw new Error("资产关系路径必须是普通文件。");
        const file = await files.read(PATH);
        if (!alive) return;
        if (!file) throw new Error(files.getSnapshot().error ?? "无法读取资产关系文件。");
        setRelations(parseRelations(file.bytes));
      }
      fileExists = Boolean(entry);
      loaded = true;
    });
  }

  async function persist(next: readonly AssetRelation[]) {
    pending = next;
    const bytes = new TextEncoder().encode(`${JSON.stringify({format: FORMAT, schemaVersion: 1, relations: next}, null, 2)}\n`);
    const saved = fileExists
      ? files.write(PATH, bytes) && await files.save(PATH)
      : await files.create(PATH, bytes, {createParents: true, acceptIdentical: true});
    if (!alive) return;
    if (!saved) {
      const file = files.getSnapshot().files.find(item => item.path === PATH);
      throw new Error(file?.saveError ?? files.getSnapshot().error ?? "资产关系保存失败，请重试。");
    }
    fileExists = true;
    setRelations(next);
    pending = null;
  }

  function canChange() {
    return alive && loaded && !phase && !pending && !files.getSnapshot().blocked;
  }

  function locate(relation: AssetRelation) {
    const key = relationKey(normalizeRelation(relation));
    const index = relations.findIndex(entry => relationKey(entry) === key);
    if (index < 0) throw new Error("这条关系已被修改或删除，请重新选择。");
    return index;
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    getRelations: (assetId: string) => relationsByAsset.get(assetId) ?? EMPTY,
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    load,
    save(value: AssetRelation, previous?: AssetRelation) {
      if (!canChange()) return Promise.resolve(false);
      return run("saving", async () => {
        const next = normalizeRelation(value);
        const assets = catalog?.getSnapshot();
        if (!assets?.loaded || assets.blocked || !next.assets.every(({assetsId}) => assets.assets.some(asset => asset.id === assetsId))) {
          throw new Error("请选择项目中现有的两个对象。");
        }
        const index = previous ? locate(previous) : -1;
        const key = relationKey(next);
        if (relations.some((entry, position) => position !== index && relationKey(entry) === key)) {
          throw new Error("这条关系已存在。");
        }
        if (index >= 0 && relationKey(relations[index]) === key) return;
        const entries = [...relations];
        if (index < 0) entries.push(next);
        else entries[index] = next;
        await persist(Object.freeze(entries));
      });
    },
    remove(relation: AssetRelation) {
      if (!canChange()) return Promise.resolve(false);
      return run("saving", async () => {
        const entries = [...relations];
        entries.splice(locate(relation), 1);
        await persist(Object.freeze(entries));
      });
    },
    retrySave() {
      const next = pending;
      if (!next || files.getSnapshot().blocked) return Promise.resolve(false);
      return run("saving", () => persist(next));
    },
    clearError() {
      if (!loaded || pending || phase || !error) return;
      error = null;
      publish();
    },
    dispose() {
      if (!alive) return;
      alive = false;
      loaded = false;
      phase = null;
      pending = null;
      error = null;
      relations = EMPTY;
      relationsByAsset.clear();
      publish();
      listeners.clear();
    },
  });
}
