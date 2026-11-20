import {i18nKey} from "@lodestory/sdk/i18n";
import type {Plugin} from "@lodestory/sdk";
import {flushSync} from "react-dom";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {assetCatalogKey, type AssetCatalog} from "@lodestory/sdk/asset-catalog";
import {assetEditorKey} from "@lodestory/sdk/asset-editor";
import {layoutKey} from "@lodestory/sdk/layout";
import {projectStorageKey, type ProjectFiles} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {backgroundTasksKey} from "@lodestory/sdk/background-tasks";
import {projectSearchKey} from "@lodestory/sdk/project-search";
import {Icon} from "@lodestory/ui";
import {createAssetSchemaStore, type AssetSchemaStore} from "./assetSchemaStore";
import {AssetTypeEditor, AssetTypeNavigation} from "./AssetManagementView";
import {AssetRecordsEditor} from "./AssetRecordsView";
import {displayedValue} from "./assetDisplayValue";
import {createAssetCatalog} from "./assetCatalog";
import {createAssetEditorPanels} from "./assetEditorPanels";
import {createAssetRelationSource} from "./assetRelationSource";
import {encodeAssetGroupFallback, VALIDATE_AND_ENCODE_GROUP} from "./assetObjectFiles";
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
  let removeTaskFallback: (() => void) | undefined;
  let disposePanels: (() => void) | undefined;
  const sessions = new Map<string, AssetSessionResources>();

  return {
    id: "asset-management",
    requires: [layoutKey, workbenchKey, projectStorageKey, contextMenuKey, projectSearchKey, backgroundTasksKey, i18nKey],
    provides: [assetCatalogKey, assetEditorKey],
    async activate(context) {
      alive = true;
      const layout = context.get(layoutKey);
      const i18n = context.get(i18nKey);
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      const contextMenus = context.get(contextMenuKey);
      const search = context.get(projectSearchKey);
      const tasks = context.get(backgroundTasksKey);
      const panels = createAssetEditorPanels(remove => flushSync(remove));
      disposePanels = panels.dispose;
      context.provide(assetEditorKey, panels.service);
      removeTaskFallback = tasks.registerFallback(VALIDATE_AND_ENCODE_GROUP, encodeAssetGroupFallback);
      context.provide(assetCatalogKey, Object.freeze({
        getCatalog(sessionId: string) { return sessions.get(sessionId)?.catalog ?? null; },
        relationSource: createAssetRelationSource(remove => flushSync(remove)),
      }));
      const onOpenTypes = () => layout.show(MAIN_CONTENT_ID);
      const onOpenAssets = () => layout.show(ASSETS_CONTENT_ID);

      try {
        removeNavigation = context.track(layout.registerContent({
          id: "asset-management.navigation",
          title: "资产管理",
          role: "navigation",
          order: 20,
          icon: <Icon name="assets"/>,
          render: ({active}) => <AssetTypeNavigation i18n={i18n} workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes} onOpenAssets={onOpenAssets}/>,
        }));
        removeMain = context.track(layout.registerContent({
          id: MAIN_CONTENT_ID,
          title: "模板设置",
          role: "main",
          order: 20,
          render: ({active}) => <AssetTypeEditor i18n={i18n} workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes} onOpenAssets={onOpenAssets}/>,
        }));
        removeAssets = context.track(layout.registerContent({
          id: ASSETS_CONTENT_ID,
          title: "对象管理",
          role: "main",
          order: 21,
          render: ({active}) => <AssetRecordsEditor i18n={i18n} workbench={workbench} sessions={sessions} contextMenus={contextMenus}
            active={active} onOpenTypes={onOpenTypes} assetEditor={panels.service}/>,
        }));
        removeParticipant = context.track(workbench.registerParticipant({
          id: "asset-management",
          label: "资产管理",
          async start(session) {
            if (!alive || sessions.has(session.id)) {
              throw new Error(`Asset schema session '${session.id}' cannot be started.`);
            }
            const files: ProjectFiles | null = storage.getFiles(session.id);
            if (!files) throw new Error(`Project storage for session '${session.id}' is unavailable.`);
            const store = createAssetSchemaStore(files, (id, data) => tasks.execute(VALIDATE_AND_ENCODE_GROUP, {id, data}));
            const catalogController = createAssetCatalog(store);
            const resource: AssetSessionResources = {
              store,
              catalog: catalogController.catalog,
              editing: new Set(),
            };
            let removeSearch: (() => void) | undefined;
            try {
              const loaded = await store.load();
              if (!loaded) throw new Error(store.getSnapshot().error ?? "资产数据加载失败。");
              if (!alive) throw new Error("Asset management stopped while the project was loading.");
              // Views and capability consumers only receive a fully initialized resource.
              sessions.set(session.id, resource);
              removeSearch = search.registerSource(session.id, "assets", {
                title: "资产",
                getSnapshot() {
                  const state = store.getSnapshot();
                  const assetsById = new Map(state.assets.map(asset => [asset.id, asset]));
                  const fieldsByOwner = new Map<string, typeof state.fields[number][]>();
                  for (const field of state.fields) {
                    if (field.status !== "active") continue;
                    const key = `${field.owner.kind}:${field.owner.id}`;
                    const fields = fieldsByOwner.get(key) ?? [];
                    fields.push(field);
                    fieldsByOwner.set(key, fields);
                  }
                  return {loading: state.loading || !state.loaded, error: state.error,
                    records: state.assets.map(asset => {
                      const fields = [...(fieldsByOwner.get(`type:${asset.typeId}`) ?? []), ...(fieldsByOwner.get(`asset:${asset.id}`) ?? [])];
                      const values = fields.filter(field => asset.values[field.id] != null && asset.values[field.id] !== ""
                        && (!Array.isArray(asset.values[field.id]) || (asset.values[field.id] as readonly string[]).length > 0))
                        .map(field => displayedValue(field, asset, state.assets, assetsById));
                      return {id: asset.id, kind: "资产", title: asset.name, detail: asset.description, text: values.join("\n")};
                    })};
                },
                subscribe(listener) {
                  let previous = store.getSnapshot();
                  return store.subscribe(() => {
                    const next = store.getSnapshot();
                    if (next.assets !== previous.assets || next.fields !== previous.fields
                      || next.loading !== previous.loading || next.loaded !== previous.loaded || next.error !== previous.error) listener();
                    previous = next;
                  });
                },
                open(id) {
                  const current = workbench.getSnapshot(), state = store.getSnapshot();
                  const asset = state.assets.find(item => item.id === id);
                  if (!alive || current.session?.id !== session.id || !current.active || current.busy || !asset
                    || resource.editing.size > 0 || state.blocked || state.saving || state.dirty) return false;
                  const typeId = state.types.some(type => type.id === asset.typeId && type.status === "active") ? asset.typeId : null;
                  if (!store.selectType(typeId) || !store.selectAsset(id)) return false;
                  layout.show(ASSETS_CONTENT_ID);
                  return true;
                },
              });
            } catch (error) {
              removeSearch?.();
              try { catalogController.dispose(); }
              finally {
                try { await store.dispose(); }
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
              async dispose() {
                try { removeSearch?.(); catalogController.dispose(); }
                finally {
                  try { await store.dispose(); }
                  finally {
                    resource.editing.clear();
                    if (sessions.get(session.id) === resource) sessions.delete(session.id);
                  }
                }
              },
            };
          },
        }));
      } catch (error) {
        alive = false;
        removeTaskFallback?.();
        removeTaskFallback = undefined;
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
      disposePanels?.();
      disposePanels = undefined;
      const unregister = removeParticipant;
      removeParticipant = undefined;
      try { await unregister?.(); } catch (error) { errors.push(error); }
      removeTaskFallback?.();
      removeTaskFallback = undefined;
      if (errors.length) throw Object.assign(new Error("Asset management failed to stop."), {errors});
    },
  };
}
