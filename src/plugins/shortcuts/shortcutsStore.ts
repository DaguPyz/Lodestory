import {ShortcutConflictError} from "@lodestory/sdk/shortcuts";
import type {
  ShortcutBinding, ShortcutCommand, ShortcutInvocation, ShortcutScope, ShortcutSnapshot, ShortcutsService,
} from "@lodestory/sdk/shortcuts";

type BindingEntry = {source: ShortcutBinding; keys: string};
type Options = {
  getOverrides(): Readonly<Record<string, string | null>>;
  persist(bindingId: string, keys: string | null | undefined): Promise<void>;
  isMac?: () => boolean;
};

const modifiers = ["Mod", "Ctrl", "Alt", "Shift"] as const;
type Modifier = typeof modifiers[number];
type Chord = Readonly<{modifiers: ReadonlySet<Modifier>; key: string}>;

function keyName(value: string): string {
  const aliases: Record<string, string> = {
    esc: "Escape", escape: "Escape", return: "Enter", enter: "Enter", space: "Space",
    " ": "Space", del: "Delete", delete: "Delete", left: "ArrowLeft", arrowleft: "ArrowLeft",
    right: "ArrowRight", arrowright: "ArrowRight", up: "ArrowUp", arrowup: "ArrowUp",
    down: "ArrowDown", arrowdown: "ArrowDown", pageup: "PageUp", pagedown: "PageDown",
    backspace: "Backspace", tab: "Tab", home: "Home", end: "End", insert: "Insert",
  };
  const lower = value.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(value)) return value.toUpperCase();
  return "";
}

export function normalizeShortcut(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("A shortcut chord is required.");
  const parts = value.split("+").map(part => part.trim());
  if (parts.some(part => !part)) throw new TypeError("Shortcut chords cannot contain empty parts.");
  const selected = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    const modifier: Modifier | undefined = ["mod", "cmd", "command", "meta", "super"].includes(lower) ? "Mod"
      : ["ctrl", "control"].includes(lower) ? "Ctrl"
      : ["alt", "option"].includes(lower) ? "Alt"
      : lower === "shift" ? "Shift" : undefined;
    if (modifier) {
      if (selected.has(modifier)) throw new TypeError(`Shortcut modifier '${modifier}' is repeated.`);
      selected.add(modifier);
      continue;
    }
    if (key) throw new TypeError("A shortcut must contain exactly one non-modifier key.");
    key = keyName(part);
    if (!key) throw new TypeError(`Unsupported shortcut key '${part}'.`);
  }
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
  const applicationModifier = selected.has("Mod") || selected.has("Ctrl") || selected.has("Alt");
  if (!key || !applicationModifier && !functionKey) {
    throw new TypeError("A shortcut must use Mod, Ctrl, Alt, or an F1–F24 key.");
  }
  return [...modifiers.filter(item => selected.has(item)), key].join("+");
}

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
}

/** Turn an actual key press into the same chord representation used by dispatch. */
export function shortcutFromKeyEvent(event: KeyboardEvent, isMac: boolean): string | null {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return null;
  if (["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) return null;
  if (!isMac && event.metaKey) throw new TypeError("The system key is not supported in shortcuts.");
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("Mod");
  if (isMac && event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key === " " ? "Space" : event.key);
  return normalizeShortcut(parts.join("+"));
}

function parseChord(value: string, isMac: boolean): Chord {
  const canonical = normalizeShortcut(value).split("+");
  const key = canonical.pop()!;
  const result = new Set<Modifier>(canonical as Modifier[]);
  if (result.has("Mod")) {
    result.delete("Mod");
    result.add(isMac ? "Mod" : "Ctrl");
  }
  return {modifiers: result, key: /^[A-Z0-9]$/.test(key) ? key.toLowerCase() : key};
}

export function formatShortcut(value: string, isMac: boolean): string {
  const keys = normalizeShortcut(value).split("+");
  const key = keys.pop()!;
  // On non-Mac platforms Mod maps to Ctrl; display the merged physical modifier once.
  const visibleKeys = !isMac && keys.includes("Mod") && keys.includes("Ctrl")
    ? keys.filter(item => item !== "Ctrl") : keys;
  if (isMac) {
    const symbols: Record<string, string> = {Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧"};
    return [...visibleKeys.map(item => symbols[item] ?? item), key].join(" ");
  }
  const labels: Record<string, string> = {Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift"};
  return [...visibleKeys.map(item => labels[item] ?? item), key].join(" + ");
}

function sameChord(left: string, right: string, isMac: boolean): boolean {
  const a = parseChord(left, isMac), b = parseChord(right, isMac);
  return a.key === b.key && a.modifiers.size === b.modifiers.size && [...a.modifiers].every(modifier => b.modifiers.has(modifier));
}

function keyMatches(event: KeyboardEvent, chord: Chord): boolean {
  const eventKey = keyName(event.key);
  if (!eventKey || (eventKey.length === 1 ? eventKey.toLowerCase() : eventKey) !== chord.key) return false;
  const expected = chord.modifiers;
  const isMac = expected.has("Mod");
  const control = expected.has("Ctrl") || !isMac && expected.has("Mod");
  const meta = expected.has("Mod") && isMac;
  return event.ctrlKey === control && event.metaKey === meta
    && event.altKey === expected.has("Alt") && event.shiftKey === expected.has("Shift");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Registration and matching state is local to one active shortcuts plugin instance. */
export function createShortcutsStore(options: Options) {
  const commands = new Map<string, ShortcutCommand>();
  const scopes = new Map<string, ShortcutScope>();
  const bindings = new Map<string, BindingEntry>();
  const pending = new Map<string, object>();
  const listeners = new Set<() => void>();
  const isMac = options.isMac ?? isMacPlatform;
  let snapshot: ShortcutSnapshot = deepFreeze({commands: [], bindings: [], conflicts: []});
  let active = true;
  let accepting = true;
  let mutationQueue: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;

  function checkActive() { if (!active || !accepting) throw new Error("Shortcuts service is no longer active."); }
  function overrides() { return options.getOverrides(); }
  function keysFor(entry: BindingEntry, source = overrides()) {
    return Object.prototype.hasOwnProperty.call(source, entry.source.id) ? source[entry.source.id] : entry.keys;
  }
  function scopeDepth(id: string, visiting = new Set<string>()): number {
    if (visiting.has(id)) throw new Error(`Shortcut scope ancestry contains a cycle at '${id}'.`);
    const scope = scopes.get(id);
    if (!scope) return -1;
    if (!scope.parentId) return 0;
    visiting.add(id);
    const parentDepth = scopeDepth(scope.parentId, visiting);
    visiting.delete(id);
    return parentDepth < 0 ? -1 : parentDepth + 1;
  }
  function scopeIsActive(id: string, target: EventTarget | null) {
    const visited = new Set<string>();
    let scope = scopes.get(id);
    while (scope) {
      if (visited.has(scope.id) || !scope.active() || scope.contains && !scope.contains(target)) return false;
      visited.add(scope.id);
      if (!scope.parentId) return true;
      scope = scopes.get(scope.parentId);
    }
    return false;
  }
  function conflictsFor(source = overrides()) {
    const result = new Map<string, {bindingIds: string[]; keys: string; scopeId: string}>();
    const values = [...bindings.values()];
    for (let index = 0; index < values.length; index++) {
      const left = values[index]!;
      const leftKeys = keysFor(left, source);
      if (!leftKeys) continue;
      for (const right of values.slice(index + 1)) {
        const rightKeys = keysFor(right, source);
        if (!rightKeys || left.source.scopeId !== right.source.scopeId || !sameChord(leftKeys, rightKeys, isMac())) continue;
        const key = `${left.source.scopeId}\0${normalizeShortcut(leftKeys)}`;
        const conflict = result.get(key) ?? {bindingIds: [], keys: normalizeShortcut(leftKeys), scopeId: left.source.scopeId};
        conflict.bindingIds.push(left.source.id, right.source.id);
        conflict.bindingIds = [...new Set(conflict.bindingIds)];
        result.set(key, conflict);
      }
    }
    return [...result.values()].map(item => deepFreeze(item));
  }
  function publish() {
    if (!active) return;
    const source = overrides();
    const conflicts = conflictsFor(source);
    const conflicted = new Set(conflicts.flatMap(conflict => conflict.bindingIds));
    const next = deepFreeze({
      commands: [...commands.values()].map(command => ({id: command.id, title: command.title, category: command.category, running: pending.has(command.id)})),
      bindings: [...bindings.values()].map(entry => {
        const keys = keysFor(entry, source);
        return {id: entry.source.id, commandId: entry.source.commandId, scopeId: entry.source.scopeId, keys,
          label: keys ? formatShortcut(keys, isMac()) : "", defaultKeys: entry.keys,
          defaultLabel: formatShortcut(entry.keys, isMac()),
          customized: Object.prototype.hasOwnProperty.call(source, entry.source.id), conflicted: conflicted.has(entry.source.id)};
      }),
      conflicts,
    });
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Shortcut listener failed.", {error}); }
    }
  }

  function registerCommand(command: ShortcutCommand) {
    checkActive();
    if (!command || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(command.id)
      || typeof command.title !== "string" || !command.title.trim() || typeof command.category !== "string" || !command.category.trim()
      || typeof command.run !== "function" || command.enabled !== undefined && typeof command.enabled !== "function") {
      throw new TypeError("Shortcut commands require a namespaced id, title, category and run function.");
    }
    if (commands.has(command.id)) throw new Error(`Shortcut command '${command.id}' is already registered.`);
    const entry = Object.freeze({...command});
    commands.set(command.id, entry);
    publish();
    return () => {
      if (commands.get(command.id) !== entry) return;
      commands.delete(command.id);
      pending.delete(command.id);
      publish();
    };
  }

  function registerScope(scope: ShortcutScope) {
    checkActive();
    if (!scope || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(scope.id) || typeof scope.active !== "function"
      || scope.contains !== undefined && typeof scope.contains !== "function") throw new TypeError("Shortcut scopes require an id and active predicate.");
    if (scopes.has(scope.id)) throw new Error(`Shortcut scope '${scope.id}' is already registered.`);
    if (scope.parentId && !scopes.has(scope.parentId)) throw new Error(`Shortcut parent scope '${scope.parentId}' is not registered.`);
    const entry = Object.freeze({...scope});
    scopes.set(entry.id, entry);
    scopeDepth(entry.id);
    publish();
    return () => {
      if (scopes.get(entry.id) !== entry) return;
      scopes.delete(entry.id);
      publish();
    };
  }

  function registerBinding(binding: ShortcutBinding) {
    checkActive();
    if (!binding || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(binding.id) || !commands.has(binding.commandId)
      || !binding.scopeId || typeof binding.scopeId !== "string" || typeof binding.keys !== "string"
      || binding.allowInInput !== undefined && typeof binding.allowInInput !== "boolean") throw new TypeError("Shortcut bindings require a unique id, registered command, scope and chord.");
    const keys = normalizeShortcut(binding.keys);
    if (bindings.has(binding.id)) throw new Error(`Shortcut binding '${binding.id}' is already registered.`);
    const entry: BindingEntry = {source: Object.freeze({...binding, keys}), keys};
    bindings.set(binding.id, entry);
    publish();
    return () => { if (bindings.get(binding.id) === entry) { bindings.delete(binding.id); publish(); } };
  }

  async function invoke(commandId: string, invocation: ShortcutInvocation): Promise<boolean> {
    checkActive();
    const command = commands.get(commandId);
    if (!command || pending.has(commandId) || command.enabled && !command.enabled(invocation)) return false;
    const token = {};
    pending.set(commandId, token);
    publish();
    try { await command.run(invocation); return true; }
    finally {
      if (pending.get(commandId) === token) {
        pending.delete(commandId);
        publish();
      }
    }
  }

  function setBinding(bindingId: string, keys: string | null | undefined) {
    if (!accepting) return Promise.reject(new Error("Shortcuts service is no longer active."));
    const entry = bindings.get(bindingId);
    if (!entry) return Promise.reject(new Error(`Shortcut binding '${bindingId}' is not registered.`));
    let normalized: string | null | undefined;
    try { normalized = keys === null || keys === undefined ? keys : normalizeShortcut(keys); }
    catch (error) { return Promise.reject(error); }
    const operation = mutationQueue.then(async () => {
      if (!active) throw new Error("Shortcuts service is no longer active.");
      const replacement = bindings.get(bindingId);
      if (replacement && replacement !== entry) throw new Error(`Shortcut binding '${bindingId}' was replaced before saving.`);
      const nextOverrides = Object.assign(Object.create(null), overrides()) as Record<string, string | null>;
      if (normalized === undefined) delete nextOverrides[bindingId];
      else nextOverrides[bindingId] = normalized;
      const proposed = keysFor(entry, nextOverrides);
      const conflictingIds = proposed ? [...bindings.values()].filter(other => other !== entry && other.source.id !== bindingId
        && other.source.scopeId === entry.source.scopeId && keysFor(other, nextOverrides)
        && sameChord(proposed, keysFor(other, nextOverrides)!, isMac())).map(other => other.source.id) : [];
      if (conflictingIds.length) throw new ShortcutConflictError(bindingId, entry.source.scopeId,
        proposed ?? "", conflictingIds);
      await options.persist(bindingId, normalized);
      publish();
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  function handleKeyDown(event: KeyboardEvent, context: {blocked: boolean; editable: boolean; target: EventTarget | null}): boolean {
    if (!active || !accepting || !context || context.blocked || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.getModifierState?.("AltGraph")) return false;
    const available = [...bindings.values()].filter(entry => {
      const keys = keysFor(entry);
      const scope = scopes.get(entry.source.scopeId);
      if (!keys || !scope || !commands.has(entry.source.commandId) || context.editable && !entry.source.allowInInput) return false;
      try { return scopeIsActive(scope.id, context.target) && keyMatches(event, parseChord(keys, isMac())); }
      catch (error) { console.error("Could not resolve shortcut scope.", {error}); return false; }
    });
    if (!available.length) return false;
    const depth = Math.max(...available.map(entry => scopeDepth(entry.source.scopeId)));
    const nearest = available.filter(entry => scopeDepth(entry.source.scopeId) === depth);
    const commandIds = new Set(nearest.map(entry => entry.source.commandId));
    event.preventDefault();
    if (event.repeat || commandIds.size !== 1 || nearest.some(entry => conflictsFor().some(conflict => conflict.bindingIds.includes(entry.source.id)))) return true;
    const [entry] = nearest;
    if (entry) void invoke(entry.source.commandId, {source: "keyboard", target: context.target}).catch(error => {
      console.error(`Shortcut command '${entry.source.commandId}' failed.`, {error});
    });
    return true;
  }

  const service: ShortcutsService = Object.freeze({
    registerCommand, registerScope, registerBinding,
    execute(commandId, args) { return invoke(commandId, {source: "ui", target: null, args}); },
    getShortcut(commandId) {
      const conflicted = new Set(conflictsFor().flatMap(conflict => conflict.bindingIds));
      const entry = [...bindings.values()].find(item => item.source.commandId === commandId && keysFor(item) && !conflicted.has(item.source.id));
      const keys = entry && keysFor(entry);
      return keys ? formatShortcut(keys, isMac()) : undefined;
    },
    getSnapshot() { checkActive(); return snapshot; },
    subscribe(listener) { checkActive(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    setBinding(bindingId, keys) { return setBinding(bindingId, keys); },
    resetBinding(bindingId) { return setBinding(bindingId, undefined); },
  });

  return {
    service,
    handleKeyDown,
    refresh: publish,
    dispose(): Promise<void> {
      if (stopping) return stopping;
      accepting = false;
      stopping = mutationQueue.then(() => {
        active = false;
        listeners.clear(); commands.clear(); scopes.clear(); bindings.clear(); pending.clear();
      });
      return stopping;
    },
  };
}
