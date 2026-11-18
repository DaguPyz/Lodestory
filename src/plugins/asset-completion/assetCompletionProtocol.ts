import type {AssetCatalogAsset, AssetCatalogType} from "@lodestory/sdk/asset-catalog";
import type {EditorCompletionCandidate, EditorHighlight} from "@lodestory/sdk/body-editor";

export type AssetTextQuery = {kind: "query" | "highlight"; text: string};
export type AssetCompletionMessage =
  | {kind: "index"; assets: readonly Pick<AssetCatalogAsset, "name" | "typeId" | "color">[];
      types: readonly Pick<AssetCatalogType, "id" | "name">[]}
  | AssetTextQuery;

export type AssetCompletionReply =
  | {kind: "indexed"}
  | {kind: "candidates"; candidates: readonly EditorCompletionCandidate[]}
  | {kind: "highlights"; highlights: readonly EditorHighlight[]};
