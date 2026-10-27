import type {Plugin} from "@lodestory/sdk";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {assetCatalogKey, type AssetCatalog} from "@lodestory/sdk/asset-catalog";
import {layoutKey} from "@lodestory/sdk/layout";
import {projectStorageKey, type ProjectFiles} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {Icon} from "@lodestory/ui";
import {createAssetSchemaStore, type AssetSchemaStore} from "./assetSchemaStore";
import {AssetTypeEditor, AssetTypeNavigation} from "./AssetManagementView";
import {AssetRecordsEditor} from "./AssetRecordsView";
import {createAssetCatalog} from "./assetCatalog";
import "./asset-management.css";

const MAIN_CONTENT_ID = "asset-management.types";
const ASSETS_CONTENT_ID = "asset-management.assets";

/** One project's asset data and form-edit guards; resources never cross workbench sessions. */
export type AssetSessionResources = {
  store: AssetSchemaStore;
  catalog: AssetCatalog;
  editing: Set<symbol>;
  handledTypeCreationRequest?: number;
};

/** Owns project asset records, type templates, field definitions, and property values. */
export function createAssetManagementPlugin(): Plugin {
  let alive = true;
  let removeNavigation: (() => void) | undefined;
  let removeMain: (() => void) | undefined;
  let removeAssets: (() => void) | undefined;
  let removeParticipant: (() => Promise<void>) | undefined;
  const sessions = new Map<string, AssetSessionResources>();

  return {
    id: "asset-management",
    requires: [layoutKey, workbenchKey, projectStorageKey, contextMenuKey],
    provides: [assetCatalogKey],
    async activate(context) {
      alive = true;
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      const contextMenus = context.get(contextMenuKey);
      context.provide(assetCatalogKey, Object.freeze({
        getCatalog(sessionId: string) { return sessions.get(sessionId)?.catalog ?? null; },
      }));
      const onOpenTypes = () => layout.show(MAIN_CONTENT_ID);
      const onOpenAssets = () => layout.show(ASSETS_CONTENT_ID);

      try {
        removeNavigation = layout.registerContent({
          id: "asset-management.navigation",
          title: "资产管理",
          role: "navigation",
          order: 20,
          icon: <Icon name="assets"/>,
          render: ({active}) => <AssetTypeNavigation workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes} onOpenAssets={onOpenAssets}/>,
        });
        removeMain = layout.registerContent({
          id: MAIN_CONTENT_ID,
          title: "模板设置",
          role: "main",
          order: 20,
          render: ({active}) => <AssetTypeEditor workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes} onOpenAssets={onOpenAssets}/>,
        });
        removeAssets = layout.registerContent({
          id: ASSETS_CONTENT_ID,
          title: "对象管理",
          role: "main",
          order: 21,
          render: ({active}) => <AssetRecordsEditor workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes}/>,
        });
        removeParticipant = workbench.registerParticipant({
          id: "asset-management",
          label: "资产管理",
          async start(session) {
            if (!alive || sessions.has(session.id)) {
              throw new Error(`Asset schema session '${session.id}' cannot be started.`);
            }
            const files: ProjectFiles | null = storage.getFiles(session.id);
            if (!files) throw new Error(`Project storage for session '${session.id}' is unavailable.`);
            const store = createAssetSchemaStore(files);
            const catalogController = createAssetCatalog(store);
            const resource: AssetSessionResources = {
              store,
              catalog: catalogController.catalog,
              editing: new Set(),
            };
            try {
              const loaded = await store.load();
              if (!loaded) throw new Error(store.getSnapshot().error ?? "资产数据加载失败。");
              if (!alive) throw new Error("Asset management stopped while the project was loading.");
              // Views and capability consumers only receive a fully initialized resource.
              sessions.set(session.id, resource);
            } catch (error) {
              try { catalogController.dispose(); }
              finally {
                try { store.dispose(); }
                finally {
                  if (sessions.get(session.id) === resource) sessions.delete(session.id);
                }
              }
              throw error;
            }
            return {
              async beforeLeave() {
                if (resource.editing.size > 0) return false;
                if (store.getSnapshot().dirty) {
                  if (!await store.retry()) return false;
                  if (resource.editing.size > 0 || store.getSnapshot().dirty) return false;
                }
                return resource.editing.size === 0 && !store.getSnapshot().dirty;
              },
              dispose() {
                try { catalogController.dispose(); }
                finally {
                  try { store.dispose(); }
                  finally {
                    resource.editing.clear();
                    if (sessions.get(session.id) === resource) sessions.delete(session.id);
                  }
                }
              },
            };
          },
        });
      } catch (error) {
        alive = false;
        const cleanupErrors: unknown[] = [];
        for (const remove of [removeAssets, removeMain, removeNavigation]) {
          try { remove?.(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        removeMain = undefined;
        removeAssets = undefined;
        removeNavigation = undefined;
        const unregister = removeParticipant;
        removeParticipant = undefined;
        if (unregister) {
          try { await unregister(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (cleanupErrors.length) throw Object.assign(error instanceof Error ? error : new Error(String(error)), {cleanupErrors});
        throw error;
      }
    },
    async deactivate() {
      alive = false;
      const errors: unknown[] = [];
      // Stop all views before unregistering the participant that owns their stores.
      for (const remove of [removeAssets, removeMain, removeNavigation]) {
        try { remove?.(); } catch (error) { errors.push(error); }
      }
      removeMain = undefined;
      removeAssets = undefined;
      removeNavigation = undefined;
      const unregister = removeParticipant;
      removeParticipant = undefined;
      try { await unregister?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Asset management failed to stop."), {errors});
    },
  };
}
