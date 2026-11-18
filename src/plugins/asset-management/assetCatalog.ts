import type {AssetCatalog, AssetCatalogAsset, AssetCatalogAssetDetails, AssetCatalogSnapshot, AssetCatalogType} from "@lodestory/sdk/asset-catalog";
import {displayedValue, orderedFields} from "./assetDisplayValue";
import type {AssetRecord, AssetSchemaSnapshot, AssetSchemaStore} from "./assetSchemaStore";

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
  const detailListeners = new Set<() => void>();
  const details = new Map<string, AssetCatalogAssetDetails>();
  let alive = true;
  const initial = store.getSnapshot();
  let sourceTypes = initial.types;
  let sourceAssets = initial.assets;
  let sourceFields = initial.fields;
  let assetsById: Map<string, AssetRecord> | undefined;
  let snapshot: AssetCatalogSnapshot = Object.freeze({types: projectTypes(sourceTypes), assets: projectAssets(sourceAssets),
    loaded: initial.loaded, loading: initial.loading, error: initial.error, blocked: initial.blocked});

  function publish() {
    if (!alive) return;
    const next = store.getSnapshot();
    const detailChanged = sourceAssets !== next.assets || sourceFields !== next.fields
      || snapshot.loaded !== next.loaded || snapshot.blocked !== next.blocked;
    sourceFields = next.fields;
    if (detailChanged) details.clear();
    let {types, assets} = snapshot;
    if (sourceTypes !== next.types) {
      sourceTypes = next.types;
      if (types.length !== sourceTypes.length || sourceTypes.some((item, i) =>
        item.id !== types[i].id || item.name !== types[i].name || item.status !== types[i].status)) types = projectTypes(sourceTypes);
    }
    if (sourceAssets !== next.assets) {
      sourceAssets = next.assets;
      assetsById = undefined;
      if (assets.length !== sourceAssets.length || sourceAssets.some((item, i) => item.id !== assets[i].id
        || item.name !== assets[i].name || item.description !== assets[i].description || item.typeId !== assets[i].typeId
        || item.color !== assets[i].color)) {
        assets = projectAssets(sourceAssets);
      }
    }
    const {loaded, loading, error, blocked} = next;
    if (snapshot.types !== types || snapshot.assets !== assets || snapshot.loaded !== loaded
      || snapshot.loading !== loading || snapshot.error !== error || snapshot.blocked !== blocked) {
      snapshot = Object.freeze({types, assets, loaded, loading, error, blocked});
      for (const listener of [...listeners]) listener();
    }
    if (detailChanged) for (const listener of [...detailListeners]) listener();
  }

  function getDetails(assetId: string): AssetCatalogAssetDetails | null {
    if (!alive || !snapshot.loaded || snapshot.blocked) return null;
    const cached = details.get(assetId);
    if (cached) return cached;
    const byId = assetsById ??= new Map(sourceAssets.map(asset => [asset.id, asset]));
    const asset = byId.get(assetId);
    if (!asset) return null;
    const displayFields = (kind: "type" | "asset", id: string | null) => Object.freeze(orderedFields(sourceFields, kind, id)
      .map(field => Object.freeze({id: field.id, label: field.title, value: displayedValue(field, asset, sourceAssets, byId)})));
    const result = Object.freeze({templateFields: displayFields("type", asset.typeId), customFields: displayFields("asset", asset.id)});
    details.set(assetId, result);
    return result;
  }

  function subscribe(group: Set<() => void>, listener: () => void) {
    if (!alive) return () => {};
    group.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      group.delete(listener);
    };
  }

  const unsubscribe = store.subscribe(publish);
  const catalog: AssetCatalog = Object.freeze({
    getSnapshot() { return snapshot; },
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    details: Object.freeze({getSnapshot: getDetails, subscribe: (listener: () => void) => subscribe(detailListeners, listener)}),
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
      try {
        for (const listener of [...listeners, ...detailListeners]) listener();
      } finally {
        listeners.clear();
        detailListeners.clear();
        details.clear();
        assetsById = undefined;
      }
    },
  });
}
