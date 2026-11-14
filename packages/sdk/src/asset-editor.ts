import type {ComponentType} from "react";
import {createServiceKey} from "./ServiceKey.js";
import type {PluginContribution} from "./Plugin.js";

export type AssetEditorPanelProps = Readonly<{
  sessionId: string;
  assetId: string;
  active: boolean;
  /** Keep the object editor open while the panel has a draft or an operation in progress. */
  onEditingChange(editing: boolean): void;
}>;

export type AssetEditorPanel = Readonly<{
  id: string;
  title: string;
  order?: number;
  View: ComponentType<AssetEditorPanelProps>;
}>;

export type AssetEditorService = Readonly<{
  /** Contribute a panel to the editor for an existing object. Give the handle to context.track. */
  registerPanel(panel: AssetEditorPanel): PluginContribution;
  getPanels(): readonly AssetEditorPanel[];
  subscribe(listener: () => void): () => void;
}>;

export const assetEditorKey = createServiceKey<AssetEditorService>("app/asset-editor");
