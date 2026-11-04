import {createServiceKey} from "./ServiceKey.js";

export type ShortcutInvocation = Readonly<{source: "keyboard" | "ui"; target: EventTarget | null; args?: unknown}>;
export type ShortcutCommand = Readonly<{
  id: string;
  title: string;
  category: string;
  enabled?(invocation: ShortcutInvocation): boolean;
  run(invocation: ShortcutInvocation): unknown | Promise<unknown>;
}>;
/** Scope membership is owned by the contributing plugin, never inferred from its private state. */
export type ShortcutScope = Readonly<{
  id: string;
  parentId?: string;
  active(): boolean;
  contains?(target: EventTarget | null): boolean;
}>;
export type ShortcutBinding = Readonly<{
  id: string;
  commandId: string;
  scopeId: string;
  /** One chord, e.g. Mod+Shift+F or F2. Mod is Command on macOS, Control elsewhere. */
  keys: string;
  allowInInput?: boolean;
}>;
export type ShortcutSnapshot = Readonly<{
  commands: readonly Readonly<{id: string; title: string; category: string; running: boolean}>[];
  bindings: readonly Readonly<{
    id: string; commandId: string; scopeId: string; keys: string | null; label: string;
    defaultKeys: string; defaultLabel: string;
    /** True when a user override exists, including an explicitly cleared binding. */
    customized: boolean; conflicted: boolean;
  }>[];
  conflicts: readonly Readonly<{bindingIds: readonly string[]; keys: string; scopeId: string}>[];
}>;

/** A proposed binding conflicts with other bindings in the same scope. */
export class ShortcutConflictError extends Error {
  readonly conflictingBindingIds: readonly string[];
  constructor(readonly bindingId: string, readonly scopeId: string, keys: string, conflictingBindingIds: readonly string[]) {
    super(`Shortcut '${keys}' conflicts in scope '${scopeId}'.`);
    this.name = "ShortcutConflictError";
    this.conflictingBindingIds = Object.freeze([...conflictingBindingIds]);
  }
}
export type ShortcutsService = Readonly<{
  registerCommand(command: ShortcutCommand): () => void;
  registerScope(scope: ShortcutScope): () => void;
  registerBinding(binding: ShortcutBinding): () => void;
  /** Rechecks availability; false means unavailable or already running. Errors reject. */
  execute(commandId: string, args?: unknown): Promise<boolean>;
  getShortcut(commandId: string): string | undefined;
  getSnapshot(): ShortcutSnapshot;
  subscribe(listener: () => void): () => void;
  /** Persist successfully before applying. null clears a default; reset restores it.
   * A same-scope collision rejects with ShortcutConflictError. */
  setBinding(bindingId: string, keys: string | null): Promise<void>;
  resetBinding(bindingId: string): Promise<void>;
}>;
export const shortcutsKey = createServiceKey<ShortcutsService>("app/shortcuts");

/** Shared IDs let buttons and menus invoke the owner's command without importing its implementation. */
export const shortcutCommandIds = Object.freeze({
  saveAll: "documents.saveAll",
  closeDocument: "documents.close",
  projectSearch: "project-search.open",
  newDocument: "project-management.newDocument",
  renameEntry: "project-management.rename",
});
export const shortcutScopeIds = Object.freeze({application: "application", workbench: "workbench", document: "document", projectTree: "project-tree"});
