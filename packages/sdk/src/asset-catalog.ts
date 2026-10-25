import {createServiceKey} from "./ServiceKey.js";

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

/** Session-scoped asset metadata owned and populated by asset-management. */
export type AssetCatalogService = {
  /** Return the read-only catalog for a live workbench session, or null when unavailable. */
  getCatalog(sessionId: string): AssetCatalog | null;
};

export const assetCatalogKey = createServiceKey<AssetCatalogService>("app/asset-catalog");
