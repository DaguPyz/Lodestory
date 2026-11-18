import type {AssetCatalogAsset, AssetCatalogType} from "@lodestory/sdk/asset-catalog";
import type {EditorCompletionCandidate} from "@lodestory/sdk/body-editor";

export type AssetCompletionMessage =
  | {kind: "index"; assets: readonly Pick<AssetCatalogAsset, "name" | "typeId">[];
      types: readonly Pick<AssetCatalogType, "id" | "name">[]}
  | {kind: "query"; textBefore: string};

export type AssetCompletionReply =
  | {kind: "indexed"}
  | {kind: "candidates"; candidates: readonly EditorCompletionCandidate[]};
