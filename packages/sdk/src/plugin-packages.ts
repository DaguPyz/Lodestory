import {createServiceKey} from "./ServiceKey.js";

/** Initial external package compatibility version. */
export const pluginHostApiVersion = "0.1.0";

export type ExternalCapability = Readonly<{id: string; version: string}>;

/** A package safely imported to disk, but not yet loaded or activated. */
export type ImportedPluginPackage = Readonly<{
  id: string;
  name: string;
  version: string;
  status: "pending-load";
  /** Desired state restored on the next application startup. */
  enabled: boolean;
  /** Set only after the user explicitly disables the plugin. */
  disabled?: boolean;
  /** The package directory was detached but could not yet be deleted. */
  removalPending?: boolean;
}>;

export type PreparedPluginPackage = Readonly<{
  id: string;
  /** Archive digest used to invalidate stale URLs when a package ID is reimported. */
  assetRevision: string;
  frontend: {entry: string; styles: string[]} | null;
  backend: {type: "process" | "dynamic-library"; entry: string} | null;
  requires: string[];
  provides: string[];
}>;

export type DevelopmentBuildStatus = Readonly<{
  revision: string | null;
  state?: "building" | "ready" | "error" | "stopped";
  error?: string;
}>;

export type DevelopmentPluginBuild = Readonly<{
  token: string;
  id: string;
  revision: string;
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
  /** Revalidates the installed package and prepares its frontend resources. */
  prepare(id: string): Promise<PreparedPluginPackage>;
  setEnabled(id: string, enabled: boolean, explicitDisable?: boolean): Promise<void>;
  /** Removes an inactive package and retries cleanup of a pending removal. */
  remove(id: string): Promise<void>;
  /** Chooses a local generated plugin project directory. */
  pickDevelopmentFolder(): Promise<string | null>;
  /** Reads the latest successful build revision and optional watcher status. */
  readDevelopmentStatus(folder: string): Promise<DevelopmentBuildStatus>;
  /** Validates and stages one immutable build revision into app-owned storage. */
  stageDevelopmentBuild(folder: string, revision: string): Promise<DevelopmentPluginBuild>;
  /** Serves staged assets and returns normal frontend/backend preparation metadata. */
  prepareDevelopmentBuild(token: string): Promise<PreparedPluginPackage>;
  /** Releases active assets while retaining staged files for rollback. */
  releaseDevelopmentAssets(token: string): Promise<void>;
  /** Discards a staged build after its assets have been released. */
  discardDevelopmentBuild(token: string): Promise<void>;
  releaseAssets(id: string): Promise<void>;
}>;

export const pluginPackagesKey = createServiceKey<PluginPackagesService>("app/plugin-packages");
