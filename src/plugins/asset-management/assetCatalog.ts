import type {AssetCatalog, AssetCatalogSnapshot, AssetCatalogType, AssetCatalogAsset} from "@lodestory/sdk/asset-catalog";
import type {AssetSchemaSnapshot, AssetSchemaStore} from "./assetSchemaStore";

export type AssetCatalogController = Readonly<{
  catalog: AssetCatalog;
  dispose(): void;
}>;

function projectTypes(types: AssetSchemaSnapshot["types"]): readonly AssetCatalogType[] {
  return Object.freeze(types.map(({id, name, status}) => Object.freeze({id, name, status})));
}

function projectAssets(assets: AssetSchemaSnapshot["assets"]): readonly AssetCatalogAsset[] {
  return Object.freeze(assets.map(({id, name, description, typeId, color}) =>
    Object.freeze({id, name, description, typeId, ...(color !== undefined ? {color} : {})})));
}

/** Projects the private asset schema into a stable, immutable public catalog. */
export function createAssetCatalog(store: AssetSchemaStore): AssetCatalogController {
  const listeners = new Set<() => void>();
  let alive = true;
  const initial = store.getSnapshot();
  let sourceTypes = initial.types;
  let sourceAssets = initial.assets;
  let snapshot: AssetCatalogSnapshot = Object.freeze({types: projectTypes(sourceTypes), assets: projectAssets(sourceAssets),
    loaded: initial.loaded, loading: initial.loading, error: initial.error, blocked: initial.blocked});

  function publish() {
    if (!alive) return;
    const next = store.getSnapshot();
    let {types, assets} = snapshot;
    if (sourceTypes !== next.types) {
      sourceTypes = next.types;
      if (types.length !== sourceTypes.length || sourceTypes.some((item, i) =>
        item.id !== types[i].id || item.name !== types[i].name || item.status !== types[i].status)) types = projectTypes(sourceTypes);
    }
    if (sourceAssets !== next.assets) {
      sourceAssets = next.assets;
      if (assets.length !== sourceAssets.length || sourceAssets.some((item, i) => item.id !== assets[i].id
        || item.name !== assets[i].name || item.description !== assets[i].description || item.typeId !== assets[i].typeId
        || item.color !== assets[i].color)) {
        assets = projectAssets(sourceAssets);
      }
    }
    const {loaded, loading, error, blocked} = next;
    if (snapshot.types === types && snapshot.assets === assets && snapshot.loaded === loaded
      && snapshot.loading === loading && snapshot.error === error && snapshot.blocked === blocked) return;
    snapshot = Object.freeze({types, assets, loaded, loading, error, blocked});
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
