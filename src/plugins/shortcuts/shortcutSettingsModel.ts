import {ShortcutConflictError, type ShortcutsService} from "@lodestory/sdk/shortcuts";

type Action = Readonly<{kind: "set"; bindingId: string; keys: string | null} | {kind: "reset"; bindingId: string}>;
type Failure = Readonly<{
  action: Action;
  kind: "conflict" | "save";
  conflictingBindingIds: readonly string[];
}>;
type Snapshot = Readonly<{pendingId: string | null; failures: readonly Failure[]}>;

/** Keep pending writes and failures when the settings section is temporarily unmounted. */
export function createShortcutSettingsModel(shortcuts: ShortcutsService) {
  const listeners = new Set<() => void>();
  let accepting = true;
  let active = true;
  let current: Promise<boolean> | undefined;
  let stopping: Promise<void> | undefined;
  let snapshot: Snapshot = Object.freeze({pendingId: null, failures: Object.freeze([])});

  function publish(next: Snapshot) {
    if (!active) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Shortcut settings subscriber failed.", {error}); }
    }
  }

  function perform(action: Action): Promise<boolean> {
    if (!accepting || current || snapshot.pendingId !== null) return Promise.resolve(false);
    const request = Object.freeze({...action});
    publish({pendingId: request.bindingId, failures: Object.freeze(snapshot.failures.filter(item => item.action.bindingId !== request.bindingId))});
    const operation = Promise.resolve().then(() => request.kind === "set"
      ? shortcuts.setBinding(request.bindingId, request.keys)
      : shortcuts.resetBinding(request.bindingId)).then(() => {
      publish({pendingId: null, failures: snapshot.failures});
      return true;
    }, error => {
      const conflict = error instanceof ShortcutConflictError ? error : null;
      const failure = Object.freeze({
        action: request,
        kind: conflict ? "conflict" : "save",
        conflictingBindingIds: Object.freeze([...(conflict?.conflictingBindingIds ?? [])]),
      } as const);
      publish({pendingId: null, failures: Object.freeze([...snapshot.failures, failure])});
      return false;
    });
    current = operation;
    void operation.then(() => { if (current === operation) current = undefined; });
    return operation;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { if (!active) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(bindingId: string, keys: string | null) { return perform({kind: "set", bindingId, keys}); },
    reset(bindingId: string) { return perform({kind: "reset", bindingId}); },
    retry(bindingId: string) {
      const failure = snapshot.failures.find(item => item.action.bindingId === bindingId && item.kind === "save");
      return failure ? perform(failure.action) : Promise.resolve(false);
    },
    clearFailure(bindingId: string) {
      if (active && snapshot.failures.some(item => item.action.bindingId === bindingId)) {
        publish({pendingId: snapshot.pendingId, failures: Object.freeze(snapshot.failures.filter(item => item.action.bindingId !== bindingId))});
      }
    },
    dispose(): Promise<void> {
      if (stopping) return stopping;
      accepting = false;
      stopping = Promise.resolve(current).then(() => { active = false; listeners.clear(); });
      return stopping;
    },
  };
}

export type ShortcutSettingsModel = ReturnType<typeof createShortcutSettingsModel>;
