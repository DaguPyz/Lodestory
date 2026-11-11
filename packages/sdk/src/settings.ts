import type {ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";

/** A plugin-owned settings view, rendered only when the user selects it. */
export type SettingsSection = Readonly<{
  id: string;
  group: string;
  title: string;
  order?: number;
  render(): ReactNode;
}>;

export type SettingsService = Readonly<{
  /** Open settings, optionally selecting a registered section. */
  open(sectionId?: string): boolean;
  /** Close the settings dialog without changing the selected section. */
  close(): void;
  /** Register a section; removal stops displaying its view before returning. */
  registerSection(section: SettingsSection): () => void;
}>;

export const settingsKey = createServiceKey<SettingsService>("app/settings");
