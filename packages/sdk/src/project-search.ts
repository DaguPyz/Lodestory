import {createServiceKey} from "./ServiceKey.js";
import {createEventKey, type EventKey} from "./EventKey.js";

/** A source owns the content and navigation represented by these records. */
export type ProjectSearchRecord = Readonly<{
    id: string;
    kind: string;
    title: string;
    detail: string;
    text: string;
}>;
export type ProjectSearchSourceSnapshot = Readonly<{
    records: readonly ProjectSearchRecord[];
    loading: boolean;
    error: string | null;
}>;
export type ProjectSearchSource = Readonly<{
    title: string;
    getSnapshot(): ProjectSearchSourceSnapshot;
    subscribe(listener: () => void): () => void;
    open(id: string): boolean | Promise<boolean>;
    refresh?(): void | Promise<void>;
}>;
export type ProjectSearchResult = ProjectSearchRecord & Readonly<{ sourceId: string }>;
export type ProjectSearchSnapshot = Readonly<{
    revision: number;
    indexing: boolean;
    issues: readonly string[];
}>;
export type ProjectSearchService = Readonly<{
    registerSource(sessionId: string, sourceId: string, source: ProjectSearchSource): () => void;
    getSnapshot(sessionId: string): ProjectSearchSnapshot;
    subscribe(listener: () => void): () => void;
    search(sessionId: string, query: string, kind?: string): readonly ProjectSearchResult[];
    open(sessionId: string, sourceId: string, id: string): Promise<boolean>;
    refresh(sessionId: string): Promise<void>;
}>;
export const projectSearchKey = createServiceKey<ProjectSearchService>("app/project-search");
/** The toolbar requests the search UI without depending on its implementation. */
export const projectSearchRequested: EventKey<Readonly<{
    sessionId: string
}>> = createEventKey("app/project-search/open");
