import type {AssetCatalog, AssetCatalogSnapshot, AssetCatalogType, AssetCatalogAsset} from "@lodestory/sdk/asset-catalog";
import type {AssetSchemaSnapshot, AssetSchemaStore} from "./assetSchemaStore";

export type AssetCatalogController = Readonly<{
  catalog: AssetCatalog;
  dispose(): void;
}>;

function projectSnapshot(source: AssetSchemaSnapshot): AssetCatalogSnapshot {
  const types: readonly AssetCatalogType[] = Object.freeze(source.types.map(type => Object.freeze({
    id: type.id,
    name: type.name,
    status: type.status,
  })));
  const assets: readonly AssetCatalogAsset[] = Object.freeze(source.assets.map(asset => Object.freeze({
    id: asset.id,
    name: asset.name,
    description: asset.description,
    typeId: asset.typeId,
  })));
  return Object.freeze({types, assets, loaded: source.loaded, loading: source.loading,
    error: source.error, blocked: source.blocked});
}

function sameCatalogSnapshot(left: AssetCatalogSnapshot, right: AssetCatalogSnapshot): boolean {
  return left.loaded === right.loaded && left.loading === right.loading && left.error === right.error
    && left.blocked === right.blocked
    && left.types.length === right.types.length
    && left.types.every((type, index) => {
      const other = right.types[index];
      return type.id === other.id && type.name === other.name && type.status === other.status;
    })
    && left.assets.length === right.assets.length
    && left.assets.every((asset, index) => {
      const other = right.assets[index];
      return asset.id === other.id && asset.name === other.name && asset.description === other.description
        && asset.typeId === other.typeId;
    });
}

/** Projects the private asset schema into a stable, immutable public catalog. */
export function createAssetCatalog(store: AssetSchemaStore): AssetCatalogController {
  const listeners = new Set<() => void>();
  let alive = true;
  let snapshot = projectSnapshot(store.getSnapshot());

  function publish() {
    if (!alive) return;
    const next = projectSnapshot(store.getSnapshot());
    if (sameCatalogSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  const unsubscribe = store.subscribe(publish);
  const catalog: AssetCatalog = Object.freeze({
    getSnapshot() { return snapshot; },
    subscribe(listener: () => void) {
      if (!alive) return () => {};
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    async retry() {
      if (!alive) return false;
      const retried = await store.retry();
      return alive && retried;
    },
  });

  return Object.freeze({
    catalog,
    dispose() {
      if (!alive) return;
      alive = false;
      unsubscribe();
      snapshot = Object.freeze({...snapshot, loading: false, blocked: true});
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  });
}
