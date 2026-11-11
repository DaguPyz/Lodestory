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
export type ExternalPluginsService = {
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  getSnapshot(): Readonly<Record<string, ExternalPluginStatus>>;
  subscribe(listener: () => void): () => void;
};
export const externalPluginsKey = createServiceKey<ExternalPluginsService>("app/external-plugins");
