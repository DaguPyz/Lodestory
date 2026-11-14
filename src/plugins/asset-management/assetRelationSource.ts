import type {AssetRelationSourceRegistration} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationsService} from "@lodestory/sdk/asset-relations";

/** A registration point for readers that can also work with the catalog alone. */
export function createAssetRelationSource(commitRemoval: (remove: () => void) => void): AssetRelationSourceRegistration {
  let current: AssetRelationsService | null = null;
  const listeners = new Set<() => void>();
  function publish(next: AssetRelationsService | null) {
    current = next;
    for (const listener of [...listeners]) {
      try { listener(); }
      catch (error) { console.error("Asset relation source subscriber failed.", {error}); }
    }
  }

  function register(source: AssetRelationsService) {
    if (typeof source?.getNetwork !== "function") throw new TypeError("An asset relation source must provide getNetwork.");
    if (current) throw new Error("An asset relation source is already registered.");
    publish(source);
    let registered = true;
    const remove = () => {
      if (!registered) return;
      commitRemoval(() => publish(null));
      registered = false;
    };
    return Object.assign(remove, {associate() {}, check() {}, withdraw: remove});
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return Object.freeze({register, subscribe, getSnapshot: () => current});
}
