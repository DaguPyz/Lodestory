import type {ProjectSearchRecord, ProjectSearchResult, ProjectSearchService, ProjectSearchSnapshot, ProjectSearchSource} from "@lodestory/sdk/project-search";

type Indexed = {record: ProjectSearchResult; searchable: string};
type SourceState = {source: ProjectSearchSource; records: Indexed[]; loading: boolean; error: string | null; generation: number; timer: ReturnType<typeof setTimeout> | null; unsubscribe: () => void};
type Session = {sources: Map<string, SourceState>; snapshot: ProjectSearchSnapshot};
const EMPTY: ProjectSearchSnapshot = Object.freeze({revision: 0, indexing: false, issues: Object.freeze([])});
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase();

/** Session-local, disposable search data; sources remain the owners of all records. */
export function createSearchIndex(): ProjectSearchService & {dispose(): void} {
  const sessions = new Map<string, Session>();
  const listeners = new Set<() => void>();
  let alive = true;
  function publish(session: Session) {
    const states = [...session.sources.values()];
    session.snapshot = Object.freeze({revision: session.snapshot.revision + 1,
      indexing: states.some(state => state.loading || state.timer !== null),
      issues: Object.freeze(states.flatMap(state => state.error ? [`${state.source.title}：${state.error}`] : []))});
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Project search subscriber failed.", error); }
    }
  }
  function rebuild(session: Session, sourceId: string, state: SourceState) {
    const generation = ++state.generation;
    if (state.timer !== null) clearTimeout(state.timer);
    let records: readonly ProjectSearchRecord[] = [];
    const built: Indexed[] = [];
    const previous = new Map(state.records.map(item => [item.record.id, item]));
    const seen = new Set<string>();
    let offset = 0;
    const batch = () => {
      if (!alive || generation !== state.generation) return;
      try {
        const end = Math.min(offset + 200, records.length);
        for (; offset < end; offset++) {
          const record: ProjectSearchRecord = records[offset];
          if (!record || typeof record.id !== "string" || !record.id || seen.has(record.id)
            || typeof record.kind !== "string" || !record.kind || typeof record.title !== "string"
            || typeof record.detail !== "string" || typeof record.text !== "string") throw new Error("索引记录无效或编号重复。");
          seen.add(record.id);
          const old = previous.get(record.id);
          if (old && old.record.kind === record.kind && old.record.title === record.title
            && old.record.detail === record.detail && old.record.text === record.text) built.push(old);
          else {
            const result = Object.freeze({...record, sourceId});
            built.push({record: result, searchable: normalize(`${record.title}\n${record.detail}\n${record.text}`)});
          }
        }
        if (offset < records.length) state.timer = setTimeout(batch, 0);
        else { state.timer = null; state.records = built; }
      } catch (error) {
        state.timer = null;
        state.loading = false;
        state.error = error instanceof Error ? error.message : "索引记录处理失败。";
      }
      publish(session);
    };
    state.timer = setTimeout(() => {
      if (!alive || generation !== state.generation) return;
      try {
        const snapshot = state.source.getSnapshot();
        state.loading = snapshot.loading;
        state.error = snapshot.error;
        records = snapshot.records;
        batch();
      } catch (error) {
        state.timer = null;
        state.error = error instanceof Error ? error.message : "读取失败";
        state.loading = false;
        publish(session);
      }
    }, 0);
    publish(session);
  }
  function removeState(state: SourceState) {
    state.generation++;
    if (state.timer !== null) clearTimeout(state.timer);
    state.unsubscribe();
  }
  return {
    registerSource(sessionId, sourceId, source) {
      if (!alive) throw new Error("Project search is stopped.");
      let session = sessions.get(sessionId);
      if (!session) { session = {sources: new Map(), snapshot: EMPTY}; sessions.set(sessionId, session); }
      if (session.sources.has(sourceId)) throw new Error(`Duplicate project search source: ${sourceId}`);
      const owner = session;
      const state: SourceState = {source, records: [], loading: true, error: null, generation: 0, timer: null, unsubscribe: () => {}};
      owner.sources.set(sourceId, state);
      try { state.unsubscribe = source.subscribe(() => rebuild(owner, sourceId, state)); rebuild(owner, sourceId, state); }
      catch (error) { owner.sources.delete(sourceId); removeState(state); throw error; }
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        removeState(state);
        if (owner.sources.get(sourceId) === state) owner.sources.delete(sourceId);
        publish(owner);
        if (owner.sources.size === 0) sessions.delete(sessionId);
      };
    },
    getSnapshot(sessionId) { return sessions.get(sessionId)?.snapshot ?? EMPTY; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    search(sessionId, query, kind) {
      const term = normalize(query.trim());
      if (!term) return [];
      return [...(sessions.get(sessionId)?.sources.values() ?? [])].flatMap(state => state.records
        .filter(item => (!kind || item.record.kind === kind) && item.searchable.includes(term)).map(item => {
          const record = item.record;
          const match = record.text.split("\n").find(value => normalize(value).includes(term));
          return match && !normalize(`${record.title}\n${record.detail}`).includes(term)
            ? Object.freeze({...record, detail: [record.detail, match].filter(Boolean).join(" · ")}) : record;
        }));
    },
    async open(sessionId, sourceId, id) {
      const state = sessions.get(sessionId)?.sources.get(sourceId);
      if (!state || !state.records.some(item => item.record.id === id)) return false;
      return Boolean(await state.source.open(id));
    },
    async refresh(sessionId) {
      const states = [...(sessions.get(sessionId)?.sources.values() ?? [])];
      await Promise.all(states.map(async state => { if (state.source.refresh) await state.source.refresh(); }));
    },
    dispose() {
      alive = false;
      for (const session of sessions.values()) for (const state of session.sources.values()) removeState(state);
      sessions.clear(); listeners.clear();
    },
  };
}
