import {createServiceKey} from "./ServiceKey.js";

export type AssetRelationEndpoint = Readonly<{
  /** The canonical asset UUID from the project asset catalog. */
  assetsId: string;
  /** Optional free text describing this asset in this relationship. */
  tag?: string;
}>;

export type AssetRelation = Readonly<{
  /** Two distinct endpoints. Tuple order carries no direction or presentation meaning. */
  assets: readonly [AssetRelationEndpoint, AssetRelationEndpoint];
  label: string;
}>;

export type AssetRelationSnapshot = Readonly<{
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  error: string | null;
}>;

export type AssetRelationNetwork = Readonly<{
  getSnapshot(): AssetRelationSnapshot;
  /** Return every stored relation containing the asset, including relations with an unavailable peer. */
  getRelations(assetId: string): readonly AssetRelation[];
  subscribe(listener: () => void): () => void;
}>;

export type AssetRelationsService = Readonly<{
  /** The network is scoped to one workbench session, and becomes unavailable when it ends. */
  getNetwork(sessionId: string): AssetRelationNetwork | null;
}>;

export const assetRelationsKey = createServiceKey<AssetRelationsService>("app/asset-relations");
