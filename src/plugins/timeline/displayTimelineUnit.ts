import type {Translate} from "@lodestory/sdk/i18n";

export function displayTimelineUnit(t: Translate, unit: string): string {
  return unit === "天" ? t("天") : unit;
}
