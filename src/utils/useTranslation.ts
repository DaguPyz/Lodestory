import {useSyncExternalStore} from "react";
import type {I18nService} from "@lodestory/sdk/i18n";
import {sourceText} from "./sourceText";

const sourceSnapshot = {t: sourceText};
const getSourceSnapshot = () => sourceSnapshot;
const subscribeToSource = () => () => {};

export function useTranslation(i18n?: I18nService) {
  const getSnapshot = i18n?.getSnapshot ?? getSourceSnapshot;
  return useSyncExternalStore(i18n?.subscribe ?? subscribeToSource, getSnapshot, getSnapshot).t;
}
