import {createServiceKey} from "./ServiceKey.js";
import type {NativeProcessRequest, NativeProcessResponse} from "./native-process-loader.js";

/** A plugin's own backend; both native forms use the same request and response. */
export type PluginBackend = {call(request: NativeProcessRequest): Promise<NativeProcessResponse>};
export type ExternalPluginOptions = {readonly backend?: PluginBackend};
export type ExternalPluginStatus = {
  readonly state: "loading" | "enabled" | "disabling" | "disabled" | "uninstalling" | "error" | "stop-error" | "uninstall-error";
  readonly error?: string;
  readonly canRetry?: boolean;
  readonly pages?: readonly Readonly<{id: string; label: string}>[];
};
/** A local development session lasts for the lifetime of the application. */
export type DevelopmentPluginStatus = {
  readonly folder: string;
  readonly id?: string;
  readonly state: "waiting" | "building" | "reloading" | "running" | "watch-stopped" | "error" | "stopping";
  readonly revision?: string;
  readonly error?: string;
  readonly canRetry?: boolean;
  readonly pages?: ExternalPluginStatus["pages"];
};
export type ExternalPluginsService = {
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  /** Starts watching a local project, using the native chooser when no folder is supplied. */
  startDevelopment(folder?: string): Promise<void>;
  retryDevelopment(): Promise<void>;
  stopDevelopment(): Promise<void>;
  getDevelopmentSnapshot(): DevelopmentPluginStatus | null;
  getSnapshot(): Readonly<Record<string, ExternalPluginStatus>>;
  subscribe(listener: () => void): () => void;
};
export const externalPluginsKey = createServiceKey<ExternalPluginsService>("app/external-plugins");
