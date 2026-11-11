import {version as reactVersion} from "react";
import {invoke, isTauri} from "@tauri-apps/api/core";
import type {Plugin} from "@lodestory/sdk";
import {pluginHostApiVersion, pluginPackagesKey, type ExternalCapability, type ImportedPluginPackage, type PluginPackagesService} from "@lodestory/sdk/plugin-packages";

type Compatibility = Readonly<{
  hostApi: string;
  react: string;
  capabilities: readonly ExternalCapability[];
}>;

export type PackageBridge = Readonly<{
  pick(): Promise<string | null>;
  list(): Promise<ImportedPluginPackage[]>;
  importPackage(path: string, compatibility: Compatibility): Promise<ImportedPluginPackage>;
}>;

const desktopBridge: PackageBridge = {
  pick() {
    if (!isTauri()) return Promise.reject(new Error("请在 Lodestory 桌面应用中导入插件。"));
    return invoke("pick_plugin_package");
  },
  list() {
    if (!isTauri()) return Promise.reject(new Error("请在 Lodestory 桌面应用中查看插件。"));
    return invoke("list_plugin_packages");
  },
  importPackage(path, compatibility) {return invoke("import_plugin_package", {path, compatibility});},
};

/** Package management owns the external capability catalog; providers register their own contracts. */
export function createPluginPackagesPlugin(bridge: PackageBridge = desktopBridge): Plugin {
  let active = false;
  let stopping = false;
  const capabilities = new Map<string, ExternalCapability>();
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (!active || stopping) return Promise.reject(new Error("插件包服务正在停止。"));
    const work = Promise.resolve().then(operation);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }
  return {
    id: "plugin-packages", requires: [], provides: [pluginPackagesKey],
    activate(context) {
      active = true;
      stopping = false;
      const importPath = (path: string) => {
        if (!path.trim()) return Promise.reject(new Error("插件包路径不能为空。"));
        if (stopping || !active) return Promise.reject(new Error("插件包服务正在停止，未导入插件。"));
        return bridge.importPackage(path, {
          hostApi: pluginHostApiVersion,
          react: reactVersion,
          capabilities: [...capabilities.values()],
        }).then(result => {
          for (const listener of [...listeners]) {
            try {listener();} catch (error) {console.error("插件包列表通知失败。", error);}
          }
          return result;
        });
      };
      const service: PluginPackagesService = {
        registerCapability(capability) {
          if (!active || stopping) throw new Error("插件包服务正在停止。");
          if (!capability.id.trim() || !capability.version.trim() || capabilities.has(capability.id)) {
            throw new Error(`外部能力声明无效或重复：${capability.id}`);
          }
          const registered = Object.freeze({...capability});
          capabilities.set(registered.id, registered);
          return () => {if (capabilities.get(registered.id) === registered) capabilities.delete(registered.id);};
        },
        list() {return run(() => bridge.list());},
        subscribe(listener) {
          if (!active || stopping) return () => {};
          listeners.add(listener);
          return () => {listeners.delete(listener);};
        },
        importFromPath(path) {return run(() => importPath(path));},
        importFromFile() {
          return run(async () => {
            const path = await bridge.pick();
            if (path === null) return null;
            return importPath(path);
          });
        },
      };
      context.onStop({
        async prepare() {stopping = true; await Promise.allSettled([...pending]);},
        cancel() {stopping = false;},
      });
      context.provide(pluginPackagesKey, Object.freeze(service));
    },
    async deactivate() {
      stopping = true;
      await Promise.allSettled([...pending]);
      active = false;
      capabilities.clear();
      listeners.clear();
    },
  };
}
