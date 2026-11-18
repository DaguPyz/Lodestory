import type {EditorCompletion, EditorFormat} from "@lodestory/sdk/body-editor";

export function createEditorCompletionRegistry() {
  type Source = {completion: EditorCompletion; revision: number; unsubscribe: () => void};
  const sources = new Map<string, Source>();
  const listeners = new Map<string, Set<() => void>>();
  let disposed = false;

  function key(sessionId: string, format: EditorFormat) { return JSON.stringify([sessionId, format]); }
  function available(source: Source | undefined): source is Source {
    try { return source?.completion.isAvailable() ?? false; } catch { return false; }
  }
  function notify(id: string) {
    for (const listener of [...(listeners.get(id) ?? [])]) {
      try { listener(); } catch { /* Subscribers cannot prevent source withdrawal. */ }
    }
  }

  return {
    register(sessionId: string, format: EditorFormat, completion: EditorCompletion) {
      const id = key(sessionId, format);
      if (disposed || sources.has(id)) throw new Error("Completion source cannot be registered.");
      const source = {completion, revision: 0, unsubscribe: () => {}};
      source.unsubscribe = completion.subscribe(() => {
        source.revision++;
        if (sources.get(id) === source) notify(id);
      });
      sources.set(id, source);
      notify(id);
      return () => {
        if (sources.get(id) !== source) return;
        sources.delete(id);
        try { source.unsubscribe(); } finally { notify(id); }
      };
    },
    connect(sessionId: string, format: EditorFormat): EditorCompletion {
      const id = key(sessionId, format);
      return {
        isAvailable: () => available(sources.get(id)),
        subscribe(listener) {
          if (disposed) return () => {};
          const group = listeners.get(id) ?? new Set();
          group.add(listener);
          listeners.set(id, group);
          return () => {
            group.delete(listener);
            if (!group.size && listeners.get(id) === group) listeners.delete(id);
          };
        },
        async query(textBefore, signal) {
          const source = sources.get(id);
          if (signal.aborted || !available(source)) return [];
          const revision = source.revision;
          try {
            const candidates = await source.completion.query(textBefore, signal);
            return !signal.aborted && sources.get(id) === source && revision === source.revision ? candidates : [];
          } catch { return []; }
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const entries = [...sources];
      sources.clear();
      const errors: unknown[] = [];
      for (const [id, source] of entries) {
        try { source.unsubscribe(); }
        catch (error) { errors.push(error); }
        finally { notify(id); }
      }
      listeners.clear();
      if (errors.length) throw Object.assign(new Error("Editor completion cleanup failed."), {errors});
    },
  };
}
