import type {MessageCatalog} from "@lodestory/sdk/i18n";

const catalogs = import.meta.glob<MessageCatalog>("../plugins/*/i18n.ts", {eager: true, import: "default"});

export function getBuiltinPluginCatalog(id: string): MessageCatalog | undefined {
  return catalogs[`../plugins/${id}/i18n.ts`];
}
