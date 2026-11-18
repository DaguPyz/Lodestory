import {createServiceKey} from "./ServiceKey.js";

/** Language IDs are locale tags. Labels are the names of the languages in their own language. */
export type LocaleOption = Readonly<{id: string; label: string}>;

export type PluralMessage = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & {other: string}>;
export type Translation = string | PluralMessage;

/** Each locale maps the exact source text to its translation. Partial catalogs are valid. */
export type MessageCatalog = Readonly<Record<string, Readonly<Record<string, Translation>>>>;

export type MessageOptions = Readonly<{
  /** Use this plugin's catalog when the same source needs a distinct translation. */
  namespace?: string;
  /** Select a plural form using the current locale. */
  count?: number;
  values?: Readonly<Record<string, string | number>>;
}>;

/** Translates source text or returns it verbatim, then interpolates any named values. */
export type Translate = (source: string, options?: MessageOptions) => string;

export type I18nSnapshot = Readonly<{
  locale: string;
  locales: readonly LocaleOption[];
  pendingLocale: string | null;
  failedLocale: string | null;
  /** Without a namespace, use a translation when the current locale's catalogs agree. */
  t: Translate;
}>;

export type I18nService = Readonly<{
  /** Changes when the locale, catalogs or language save status change. */
  getSnapshot(): I18nSnapshot;
  subscribe(listener: () => void): () => void;
  /** Registers a plugin-owned namespace. The idempotent disposer removes its entire catalog. */
  registerMessages(namespace: string, catalog: MessageCatalog): () => void;
  /** Persists the application language before applying it. A rejected save keeps the effective locale. */
  setLocale(id: string): Promise<void>;
}>;

export const i18nKey = createServiceKey<I18nService>("app/i18n");
