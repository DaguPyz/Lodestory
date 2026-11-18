import {useId, useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {i18nKey, type I18nService} from "@lodestory/sdk/i18n";
import {settingsKey} from "@lodestory/sdk/settings";
import {Button, Select} from "@lodestory/ui";
import "./language-settings.css";

function LanguageSettings({i18n}: {i18n: I18nService}) {
  const label = useId();
  const {locale, locales, pendingLocale, failedLocale, t} = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
  const apply = (id: string) => { void i18n.setLocale(id).catch(() => {}); };
  return <div className="language-settings">
    <div className="language-settings-control">
      <span id={label}>{t("界面语言")}</span>
      <Select aria-labelledby={label} value={locale} onValueChange={apply}
        options={locales.map(option => ({value: option.id, label: option.label}))}/>
    </div>
    {pendingLocale && <p className="language-settings-saving" role="status">{t("正在保存…")}</p>}
    {failedLocale && <div className="language-settings-error">
      <p role="alert">{t("语言设置未能保存。")}</p>
      <Button variant="ghost" onClick={() => apply(failedLocale)}>{t("重试")}</Button>
    </div>}
  </div>;
}

/** The settings entry is optional. Language state and saving belong to i18n. */
export function createLanguageSettingsPlugin(): Plugin {
  let removeSection: (() => void) | undefined;
  return {
    id: "language-settings", requires: [settingsKey, i18nKey], provides: [],
    activate(context) {
      const i18n = context.get(i18nKey);
      const settings = context.get(settingsKey);
      removeSection = settings.registerSection({
        id: "general.language", group: "通用", title: "语言", order: 25,
        render: () => <LanguageSettings i18n={i18n}/>,
      });
    },
    deactivate() {
      const remove = removeSection;
      removeSection = undefined;
      remove?.();
    },
  };
}
