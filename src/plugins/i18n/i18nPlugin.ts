import type {Plugin} from "@lodestory/sdk";
import {configKey, type ConfigItem} from "@lodestory/sdk/config";
import {i18nKey, type I18nService, type I18nSnapshot, type MessageCatalog, type Translate, type Translation} from "@lodestory/sdk/i18n";
import {sourceText} from "../../utils/sourceText";

const defaultLocale = "zh-CN";
const locales = Object.freeze([
  Object.freeze({id: defaultLocale, label: "简体中文"}),
  Object.freeze({id: "en", label: "English"}),
]);
const localeConfig: ConfigItem<string> = {
  id: "i18n.locale", defaultValue: defaultLocale, effect: "live",
  validate: (value): value is string => locales.some(option => option.id === value),
};

type Catalog = ReadonlyMap<string, ReadonlyMap<string, Translation>>;
const pluralForms: readonly Intl.LDMLPluralRule[] = ["zero", "one", "two", "few", "many", "other"];

function copyCatalog(source: MessageCatalog): Catalog {
  const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const catalog = new Map<string, ReadonlyMap<string, Translation>>();
  for (const [locale, messages] of Object.entries(source)) {
    const entries = new Map<string, Translation>();
    for (const [original, translation] of Object.entries(messages)) {
      const plural = translation && typeof translation === "object"
        && Object.prototype.hasOwnProperty.call(translation, "other") && isText(translation.other)
        && Object.entries(translation).every(([form, text]) => pluralForms.includes(form as Intl.LDMLPluralRule) && isText(text));
      if (!original.trim() || (!isText(translation) && !plural)) {
        throw new TypeError(`Invalid translation for '${original}'.`);
      }
      entries.set(original, typeof translation === "string" ? translation : Object.freeze({...translation}));
    }
    catalog.set(locale, entries);
  }
  return catalog;
}

function sameTranslation(left: Translation | undefined, right: Translation) {
  return left === right || (typeof left === "object" && typeof right === "object"
    && pluralForms.every(form => left[form] === right[form]));
}

function createTranslator(locale: string, catalogs: ReadonlyMap<string, Catalog>): Translate {
  const translations = new Map<string, Translation | undefined>();
  const byNamespace = new Map<string, ReadonlyMap<string, Translation>>();
  const plural = new Intl.PluralRules(locale);
  for (const [namespace, catalog] of catalogs) {
    const messages = catalog.get(locale);
    if (!messages) continue;
    byNamespace.set(namespace, messages);
    for (const [source, translation] of messages) {
      if (!translations.has(source)) translations.set(source, translation);
      else if (!sameTranslation(translations.get(source), translation)) translations.set(source, undefined);
    }
  }
  return (source, options) => {
    const messages = options?.namespace === undefined ? translations : byNamespace.get(options.namespace);
    const translation = messages?.get(source);
    const form = options?.count === undefined ? "other" : plural.select(options.count);
    const text = typeof translation === "string" ? translation : translation?.[form] ?? translation?.other ?? source;
    return sourceText(text, options);
  };
}

/** Application-scoped language state and message registry backed by the public config service. */
export function createI18nPlugin(): Plugin {
  let dispose: (() => Promise<void>) | undefined;
  return {
    id: "i18n",
    requires: [configKey],
    provides: [i18nKey],
    activate(context) {
      const config = context.get(configKey);
      const root = typeof document === "undefined" ? undefined : document.documentElement;
      const previousLang = root?.getAttribute("lang");
      const catalogs = new Map<string, Catalog>();
      const listeners = new Set<() => void>();
      let active = true;
      let removeConfig: (() => void) | undefined;
      let lastWrite: Promise<void> | undefined;
      let pendingLocale: string | null = null;
      let failedLocale: string | null = null;
      let snapshot: I18nSnapshot;
      let appliedLang: string | undefined;

      function publish() {
        const locale = config.getSnapshot(localeConfig);
        if (root && locale !== appliedLang) {
          root.setAttribute("lang", locale);
          appliedLang = locale;
        }
        snapshot = Object.freeze({locale, locales, pendingLocale, failedLocale, t: createTranslator(locale, catalogs)});
        for (const listener of [...listeners]) {
          try { listener(); } catch (error) { console.error("Language subscriber failed.", {error}); }
        }
      }

      dispose = async () => {
        active = false;
        listeners.clear();
        await lastWrite?.catch(() => {});
        try { removeConfig?.(); }
        finally {
          catalogs.clear();
          if (root && appliedLang !== undefined && root.getAttribute("lang") === appliedLang) {
            if (previousLang == null) root.removeAttribute("lang");
            else root.setAttribute("lang", previousLang);
          }
        }
      };
      removeConfig = config.register(localeConfig);
      publish();
      const service: I18nService = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (!active) return () => {};
          const subscription = () => listener();
          listeners.add(subscription);
          return () => { listeners.delete(subscription); };
        },
        registerMessages(namespace, source) {
          if (!active) throw new Error("The language service has stopped.");
          if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new TypeError("Messages require a plugin namespace.");
          if (catalogs.has(namespace)) throw new Error(`Messages for '${namespace}' are already registered.`);
          const catalog = copyCatalog(source);
          catalogs.set(namespace, catalog);
          try { publish(); }
          catch (error) { catalogs.delete(namespace); throw error; }
          return () => {
            if (catalogs.get(namespace) !== catalog) return;
            catalogs.delete(namespace);
            if (active) publish();
          };
        },
        async setLocale(id) {
          if (!active) throw new Error("The language service has stopped.");
          if (!localeConfig.validate(id)) throw new RangeError(`Unsupported interface language '${id}'.`);
          const write = config.set(localeConfig, id);
          lastWrite = write;
          pendingLocale = id;
          failedLocale = null;
          publish();
          let failure: string | null = null;
          try { await write; }
          catch (error) { failure = id; throw error; }
          finally {
            if (lastWrite === write) {
              lastWrite = undefined;
              pendingLocale = null;
              failedLocale = failure;
            }
            if (active) publish();
          }
        },
      };
      context.provide(i18nKey, Object.freeze(service));
    },
    async deactivate() {
      const stop = dispose;
      dispose = undefined;
      await stop?.();
    },
  };
}
