import {createServiceKey} from "./ServiceKey.js";
import {createEventKey, type EventKey} from "./EventKey.js";

/** A source owns the content and navigation represented by these records. */
export type ProjectSearchRecord = Readonly<{
    id: string;
    kind: string;
    title: string;
    detail: string;
    text: string;
    /** Return a result for each occurrence in text, rather than one resource result. */
    matchMode?: "text-occurrences";
}>;
export type ProjectSearchMatch = Readonly<{start: number; end: number; line: number; text: string; sourceText: string}>;
export type ProjectSearchSourceSnapshot = Readonly<{
    records: readonly ProjectSearchRecord[];
    loading: boolean;
    error: string | null;
    progress?: Readonly<{completed: number; total: number}>;
}>;
export type ProjectSearchSource = Readonly<{
    title: string;
    getSnapshot(): ProjectSearchSourceSnapshot;
    subscribe(listener: () => void): () => void;
    open(id: string, match?: ProjectSearchMatch): boolean | Promise<boolean>;
    refresh?(): void | Promise<void>;
}>;
export type ProjectSearchResult = ProjectSearchRecord & Readonly<{ sourceId: string; match?: ProjectSearchMatch }>;
export type ProjectSearchSnapshot = Readonly<{
    revision: number;
    indexing: boolean;
    issues: readonly string[];
    progress?: readonly Readonly<{title: string; completed: number; total: number}>[];
}>;
export type ProjectSearchService = Readonly<{
    registerSource(sessionId: string, sourceId: string, source: ProjectSearchSource): () => void;
    getSnapshot(sessionId: string): ProjectSearchSnapshot;
    subscribe(listener: () => void): () => void;
    search(sessionId: string, query: string, kind?: string): readonly ProjectSearchResult[];
    /** Search in batches; cancelled requests never publish a later batch. */
    searchAsync(sessionId: string, query: string, kind: string | undefined, signal: AbortSignal,
      onBatch: (results: readonly ProjectSearchResult[]) => void): Promise<void>;
    open(sessionId: string, sourceId: string, id: string, match?: ProjectSearchMatch): Promise<boolean>;
    refresh(sessionId: string): Promise<void>;
}>;
export const projectSearchKey = createServiceKey<ProjectSearchService>("app/project-search");
/** The toolbar requests the search UI without depending on its implementation. */
export const projectSearchRequested: EventKey<Readonly<{
    sessionId: string
}>> = createEventKey("app/project-search/open");
