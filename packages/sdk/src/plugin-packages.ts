import {createServiceKey} from "./ServiceKey.js";

/** The initial package compatibility contract; it does not imply external code can run yet. */
export const pluginHostApiVersion = "0.1.0";

export type ExternalCapability = Readonly<{id: string; version: string}>;

/** A package safely imported to disk, but not yet loaded or activated. */
export type ImportedPluginPackage = Readonly<{
  id: string;
  name: string;
  version: string;
  status: "pending-load";
}>;

export type PluginPackagesService = Readonly<{
  /** Capability providers register only contracts they actually implement. */
  registerCapability(capability: ExternalCapability): () => void;
  list(): Promise<readonly ImportedPluginPackage[]>;
  /** Notifies listeners after a package has been successfully recorded. */
  subscribe(listener: () => void): () => void;
  /** Imports a package from a local path; all sources use the same validation. */
  importFromPath(path: string): Promise<ImportedPluginPackage>;
  /** Opens a native chooser; cancellation returns null. */
  importFromFile(): Promise<ImportedPluginPackage | null>;
}>;

export const pluginPackagesKey = createServiceKey<PluginPackagesService>("app/plugin-packages");
