import {createServiceKey} from "./ServiceKey.js";
import type {AssetRelationsService} from "./asset-relations.js";
import type {PluginContribution} from "./Plugin.js";

export type AssetCatalogType = Readonly<{
  /** Stable canonical lowercase UUID, matching the type ID used by assets. */
  id: string;
  name: string;
  status: "active" | "archived";
}>;

export type AssetCatalogAsset = Readonly<{
  /** Stable canonical lowercase UUID suitable for storing as an opaque reference. */
  id: string;
  name: string;
  description: string;
  /** The canonical lowercase UUID of its type, or null when unclassified. */
  typeId: string | null;
  /** Author-selected #RRGGBB color, if configured on this asset. */
  color?: string;
}>;

export type AssetCatalogSnapshot = Readonly<{
  types: readonly AssetCatalogType[];
  assets: readonly AssetCatalogAsset[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  blocked: boolean;
}>;

/** Read-only project asset metadata for cross-plugin selection and display. */
export type AssetCatalog = {
  getSnapshot(): AssetCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry loading or saving the catalog while its project session remains active. */
  retry(): Promise<boolean>;
};

export type AssetRelationSourceRegistration = Readonly<{
  /** Publish the optional source of relationship networks. Give the handle to context.track. */
  register(source: AssetRelationsService): PluginContribution;
  getSnapshot(): AssetRelationsService | null;
  subscribe(listener: () => void): () => void;
}>;

/** Session-scoped asset metadata owned and populated by asset-management. */
export type AssetCatalogService = {
  /** Return the read-only catalog for a live workbench session, or null when unavailable. */
  getCatalog(sessionId: string): AssetCatalog | null;
  /** Optional discovery point for consumers that can also work without relationships. */
  relationSource?: AssetRelationSourceRegistration;
};

export const assetCatalogKey = createServiceKey<AssetCatalogService>("app/asset-catalog");
