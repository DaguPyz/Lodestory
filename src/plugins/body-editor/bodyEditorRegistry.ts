import type {BodyEditorService, EditorConversion, EditorDefinition, EditorFormat, EditorReplacement} from "@lodestory/sdk/body-editor";

type EditorModule = Awaited<ReturnType<EditorDefinition["load"]>>;
type Entry = {
  source: Readonly<EditorDefinition>;
  definition: Readonly<EditorDefinition>;
  pending?: Promise<EditorModule>;
};

const formats: readonly EditorFormat[] = ["markdown", "plain-text", "rich-delta"];

export type ResolvedEditorConversion = Readonly<EditorConversion & {key: string}>;

export function getEditorFormat(fileName: string): EditorFormat | undefined {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt") return "plain-text";
  if (extension === "lode") return "rich-delta";
  return undefined;
}

/** Startup registry; editor code is shared, while mounted instances belong to documents. */
export function createBodyEditorRegistry(
  defaults: Readonly<Partial<Record<EditorFormat, string>>>,
  beforeRemove: () => void,
) {
  const associations = Object.freeze({...defaults});
  for (const [format, id] of Object.entries(associations)) {
    if (!formats.includes(format as EditorFormat)) throw new TypeError("Unknown editor format.");
    if (typeof id !== "string" || !id.trim()) throw new TypeError("Default editor id cannot be empty.");
  }
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let started = false;
  let alive = true;
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Subscription callbacks cannot block registry cleanup. */ }
    }
  }

  function checkActive() {
    if (!alive) throw new Error("Body editor registry is no longer active.");
  }

  function checkEntry(entry: Entry) {
    checkActive();
    if (!started) throw new Error("Body editor registry is not ready.");
    if (entries.get(entry.source.id) !== entry) throw new Error("Editor is no longer registered.");
  }

  function load(entry: Entry): Promise<EditorModule> {
    try { checkEntry(entry); }
    catch (error) { return Promise.reject(error); }
    if (entry.pending) return entry.pending;
    const pending: Promise<EditorModule> = Promise.resolve().then(() => {
      checkEntry(entry);
      return entry.source.load();
    }).then(module => {
      checkEntry(entry);
      const component: unknown = module?.default;
      if (typeof component !== "function" && !(component && typeof component === "object" && "$$typeof" in component)) {
        throw new TypeError("Editor module must export a React component as default.");
      }
      return module;
    }).catch(error => {
      if (entry.pending === pending) entry.pending = undefined;
      throw error;
    });
    entry.pending = pending;
    return pending;
  }

  function resolveEntry(format: EditorFormat): Entry | undefined {
    const id = associations[format];
    const configured = id === undefined ? undefined : entries.get(id);
    if (configured?.source.formats.includes(format)) return configured;
    if (id === undefined) return undefined;
    return [...entries.values()].find(candidate => candidate.source.formats.includes(format)
      && candidate.source.replaces?.some((replacement: EditorReplacement) => replacement.id === id && replacement.format === format));
  }

  const service: BodyEditorService = Object.freeze({
    registerEditor(definition: EditorDefinition) {
      checkActive();
      if (started) throw new Error("Body editors must be registered before pluginsReady.");
      if (!definition || typeof definition !== "object") throw new TypeError("Editor definition must be an object.");
      if (typeof definition.id !== "string" || !definition.id.trim()) throw new TypeError("Editor id cannot be empty.");
      if (!Array.isArray(definition.formats) || !definition.formats.length
        || definition.formats.some(format => !formats.includes(format))
        || new Set(definition.formats).size !== definition.formats.length) {
        throw new TypeError("Editor formats must be a non-empty list of distinct supported formats.");
      }
      if (typeof definition.load !== "function") throw new TypeError("Editor must have a load function.");
      if (definition.conversions !== undefined && (!Array.isArray(definition.conversions)
        || definition.conversions.some(conversion => !conversion || typeof conversion !== "object"
          || typeof conversion.id !== "string" || !conversion.id.trim()
          || typeof conversion.label !== "string" || !conversion.label.trim()
          || !formats.includes(conversion.from)
          || typeof conversion.extension !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(conversion.extension)
          || typeof conversion.convert !== "function")
        || new Set(definition.conversions.map(conversion => conversion.id)).size !== definition.conversions.length)) {
        throw new TypeError("Editor conversions must have distinct ids, supported source formats, and valid handlers.");
      }
      if (definition.replaces !== undefined && (!Array.isArray(definition.replaces)
        || definition.replaces.some(replacement => !replacement || typeof replacement !== "object"
          || typeof replacement.id !== "string" || !replacement.id.trim() || !definition.formats.includes(replacement.format))
        || new Set(definition.replaces.map(replacement => `${replacement.format}:${replacement.id}`)).size !== definition.replaces.length)) {
        throw new TypeError("Editor replacements must have distinct ids and supported formats.");
      }
      for (const replacement of definition.replaces ?? []) {
        if ([...entries.values()].some(entry => entry.source.replaces?.some(previous =>
          previous.id === replacement.id && previous.format === replacement.format))) {
          throw new Error("An editor replacement is already registered for this id and format.");
        }
      }
      if (entries.has(definition.id)) throw new Error("Editor id is already registered.");
      const source: Readonly<EditorDefinition> = Object.freeze({
        id: definition.id,
        formats: Object.freeze([...definition.formats]),
        ...(definition.getText ? {getText: definition.getText} : {}),
        ...(definition.conversions ? {conversions: Object.freeze(definition.conversions.map(conversion => Object.freeze({...conversion})))} : {}),
        ...(definition.replaces ? {replaces: Object.freeze(definition.replaces.map(replacement => Object.freeze({...replacement})))} : {}),
        load: definition.load,
      });
      const entry: Entry = {source, definition: source};
      entry.definition = Object.freeze({...source, load: () => load(entry)});
      entries.set(source.id, entry);
      notify();
      return () => {
        if (!alive || entries.get(source.id) !== entry) return;
        try {
          if (started) beforeRemove();
        } finally {
          if (entries.get(source.id) === entry) entries.delete(source.id);
          entry.pending = undefined;
          notify();
        }
      };
    },
    getText(fileName, content) {
      if (!alive || !started) return undefined;
      const format = getEditorFormat(fileName);
      if (!format) return undefined;
      const entry = resolveEntry(format);
      const definition = entry?.source.formats.includes(format) ? entry.definition : undefined;
      if (!definition) return undefined;
      if (!definition.getText) return format === "rich-delta" ? undefined : content;
      try {
        const text = definition.getText(content, format);
        return typeof text === "string" ? text : undefined;
      } catch {
        return undefined;
      }
    },
    subscribe(listener) {
      checkActive();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });

  return {
    service,
    start() {
      checkActive();
      started = true;
    },
    resolve(format: EditorFormat): Readonly<EditorDefinition> | undefined {
      checkActive();
      if (!started) throw new Error("Body editor registry is not ready.");
      return resolveEntry(format)?.definition;
    },
    getConversions(format: EditorFormat): readonly ResolvedEditorConversion[] {
      checkActive();
      if (!started) throw new Error("Body editor registry is not ready.");
      return Object.freeze([...entries.values()].flatMap(entry => (entry.source.conversions ?? [])
        .filter(conversion => conversion.from === format)
        .map(conversion => Object.freeze({...conversion, key: `${entry.source.id}:${conversion.id}`}))));
    },
    dispose() {
      if (!alive) return;
      try {
        if (started && entries.size) beforeRemove();
      } finally {
        alive = false;
        for (const entry of entries.values()) entry.pending = undefined;
        entries.clear();
        notify();
        listeners.clear();
      }
    },
  };
}

export type BodyEditorRegistry = ReturnType<typeof createBodyEditorRegistry>;

