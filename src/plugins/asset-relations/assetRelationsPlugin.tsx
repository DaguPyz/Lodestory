import type {Plugin, PluginAsyncContribution, PluginContribution} from "@lodestory/sdk";
import {assetCatalogKey, type AssetCatalog} from "@lodestory/sdk/asset-catalog";
import {assetEditorKey} from "@lodestory/sdk/asset-editor";
import {assetRelationsKey, type AssetRelationNetwork} from "@lodestory/sdk/asset-relations";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createAssetRelationStore, type AssetRelationStore} from "./assetRelationStore";
import {AssetRelationPanel} from "./AssetRelationPanel";
import "./asset-relations.css";

export type AssetRelationSession = Readonly<{
  catalog: AssetCatalog | null;
  store: AssetRelationStore;
  network: AssetRelationNetwork;
  editing: Set<symbol>;
}>;

export function createAssetRelationsPlugin(): Plugin {
  const sessions = new Map<string, AssetRelationSession>();
  let removeParticipant: PluginAsyncContribution | undefined;
  let removePanel: PluginContribution | undefined;

  return {
    id: "asset-relations",
    requires: [assetEditorKey, assetCatalogKey, workbenchKey, projectStorageKey],
    provides: [assetRelationsKey],
    activate(context) {
      const editor = context.get(assetEditorKey);
      const catalogs = context.get(assetCatalogKey);
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      context.provide(assetRelationsKey, Object.freeze({
        getNetwork: (sessionId: string) => sessions.get(sessionId)?.network ?? null,
      }));
      removeParticipant = context.track(workbench.registerParticipant({
        id: "asset-relations",
        label: "资产关系",
        async start({id}) {
          const files = storage.getFiles(id);
          if (!files) throw new Error(`Project storage for session '${id}' is unavailable.`);
          const catalog = catalogs.getCatalog(id);
          const store = createAssetRelationStore(files, catalog);
          const network: AssetRelationNetwork = Object.freeze({
            getSnapshot: store.getSnapshot, getRelations: store.getRelations, subscribe: store.subscribe,
          });
          const resource: AssetRelationSession = {store, catalog, network, editing: new Set()};
          await store.load();
          sessions.set(id, resource);
          return {
            beforeLeave() {
              const {saving, pending} = store.getSnapshot();
              return resource.editing.size === 0 && !saving && !pending;
            },
            dispose() {
              sessions.delete(id);
              resource.editing.clear();
              store.dispose();
            },
          };
        },
      }));
      removePanel = context.track(editor.registerPanel({
        id: "asset-relations.panel",
        title: "资产关系",
        View: props => <AssetRelationPanel {...props} resource={sessions.get(props.sessionId)}/>,
      }));
    },
    async deactivate() {
      try { removePanel?.(); }
      finally {
        removePanel = undefined;
        const unregister = removeParticipant;
        removeParticipant = undefined;
        await unregister?.();
      }
    },
  };
}
