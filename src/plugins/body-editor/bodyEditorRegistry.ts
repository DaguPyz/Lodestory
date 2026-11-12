import type {BodyEditorService, EditorDefinition, EditorFormat, EditorSearchTarget} from "@lodestory/sdk/body-editor";

type EditorModule = Awaited<ReturnType<EditorDefinition["load"]>>;
type Entry = {
  source: Readonly<EditorDefinition>;
  definition: Readonly<EditorDefinition>;
  pending?: Promise<EditorModule>;
};

const formats: readonly EditorFormat[] = ["plain-text"];

export function getEditorFormat(fileName: string): EditorFormat | undefined {
  return /\.txt$/i.test(fileName) ? "plain-text" : undefined;
}

/** Startup registry; editor code is shared, while mounted instances belong to documents. */
export function createBodyEditorRegistry(
  defaults: Readonly<Partial<Record<EditorFormat, string>>>,
  beforeRemove: () => void,
  revealSearchTarget: (sessionId: string, target: EditorSearchTarget) => boolean = () => false,
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
    return configured?.source.formats.includes(format) ? configured : undefined;
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
      if (definition.scrollMode !== undefined && definition.scrollMode !== "document" && definition.scrollMode !== "editor") {
        throw new TypeError("Editor scroll mode must be document or editor.");
      }
      if (entries.has(definition.id)) throw new Error("Editor id is already registered.");
      const source: Readonly<EditorDefinition> = Object.freeze({
        id: definition.id,
        formats: Object.freeze([...definition.formats]),
        ...(definition.scrollMode !== undefined ? {scrollMode: definition.scrollMode} : {}),
        ...(definition.getText ? {getText: definition.getText} : {}),
        ...(definition.getSearchText ? {getSearchText: definition.getSearchText} : {}),
        load: definition.load,
      });
      const entry: Entry = {source, definition: source};
      entry.definition = Object.freeze({...source, load: () => load(entry)});
      entries.set(source.id, entry);
      notify();
      const dispose = () => {
        if (!alive || entries.get(source.id) !== entry) return;
        if (started) beforeRemove();
        if (entries.get(source.id) === entry) entries.delete(source.id);
        entry.pending = undefined;
        notify();
      };
      return Object.assign(dispose, {
        associate() {},
        check(scope: "plugin" | "application") {
          if (scope === "plugin" && alive && started && entries.get(source.id) === entry) {
            throw new Error(`Editor '${source.id}' cannot be removed while editor sessions are running.`);
          }
        },
        withdraw(scope: "plugin" | "application") { if (scope === "plugin") dispose(); },
      });
    },
    getText(fileName, content) {
      if (!alive || !started) return undefined;
      const format = getEditorFormat(fileName);
      if (!format) return undefined;
      const definition = resolveEntry(format)?.definition;
      if (!definition) return undefined;
      if (!definition.getText) return content;
      try {
        const text = definition.getText(content, format);
        return typeof text === "string" ? text : undefined;
      } catch {
        return undefined;
      }
    },
    async getSearchText(fileName, content, signal) {
      if (!alive || !started || signal?.aborted) return undefined;
      const format = getEditorFormat(fileName);
      if (!format) return undefined;
      const entry = resolveEntry(format);
      if (!entry) return undefined;
      try {
        const getText = entry.definition.getSearchText ?? entry.definition.getText;
        if (!getText) return content;
        const text = await getText(content, format, signal);
        if (!alive || signal?.aborted || entries.get(entry.source.id) !== entry) return undefined;
        return typeof text === "string" ? text : undefined;
      } catch { return undefined; }
    },
    revealSearchTarget,
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

