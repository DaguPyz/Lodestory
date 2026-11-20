import type {Translate} from "@lodestory/sdk/i18n";
import {sourceText} from "../../utils/sourceText";
import type {AssetFieldDefinition, AssetRecord} from "./assetSchemaStore";

export function orderedFields(fields: readonly AssetFieldDefinition[], kind: "type" | "asset", id: string | null) {
  return fields.filter(field => field.status === "active" && field.owner.kind === kind && field.owner.id === id)
    .sort((a, b) => a.order - b.order);
}

export function displayedValue(field: AssetFieldDefinition, asset: AssetRecord, assets: readonly AssetRecord[], assetsById?: ReadonlyMap<string, AssetRecord>, t: Translate = sourceText): string {
  const value = asset.values[field.id];
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return t("未填写");
  if (field.valueType === "singleSelect" || field.valueType === "multiSelect") {
    const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string" ? [value] : [];
    return ids.map(id => field.config.options?.find(option => option.id === id)?.title ?? t("已失效的选项")).join("、");
  }
  if (field.valueType === "reference") return typeof value === "string"
    ? (assetsById ? assetsById.get(value) : assets.find(item => item.id === value))?.name ?? t("关联对象不可用") : t("关联对象不可用");
  return String(value);
}

