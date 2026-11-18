import type {Plugin} from "@lodestory/sdk";
import {assetCatalogKey} from "@lodestory/sdk/asset-catalog";
import {bodyEditorKey} from "@lodestory/sdk/body-editor";
import {workbenchKey} from "@lodestory/sdk/workbench";

export function createAssetCompletionPlugin(): Plugin {
  let unregister: (() => Promise<void>) | undefined;
  return {
    id: "asset-completion",
    requires: [assetCatalogKey, bodyEditorKey, workbenchKey],
    provides: [],
    activate(context) {
      const catalogs = context.get(assetCatalogKey);
      const editor = context.get(bodyEditorKey);
      const workbench = context.get(workbenchKey);
      unregister = context.track(workbench.registerParticipant({
        id: "asset-completion",
        label: "正文补全",
        async start(session) {
          const catalog = catalogs.getCatalog(session.id);
          if (!catalog || typeof Worker === "undefined") return {dispose() {}};
          try {
            const {createAssetCompletionSource} = await import("./assetCompletionSource");
            const source = createAssetCompletionSource(catalog);
            try {
              const remove = editor.registerCompletionSource(session.id, "plain-text", source);
              return {dispose() { try { remove(); } finally { source.dispose(); } }};
            } catch (error) {
              source.dispose();
              throw error;
            }
          } catch (error) {
            console.warn("Asset completion is unavailable.", error);
            return {dispose() {}};
          }
        },
      }));
    },
    async deactivate() {
      const remove = unregister;
      unregister = undefined;
      await remove?.();
    },
  };
}
