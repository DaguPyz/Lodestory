import {createServiceKey} from "./ServiceKey.js";

export type TimelineSaveState = "saved" | "pending" | "saving" | "error";

/** Public list metadata owned by the timeline feature. */
export type TimelineListEntry = Readonly<{
    id: string;
    title: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
    /** Numeric range of event positions, formatted with the axis unit; empty when no range is known. */
    period: string;
    /** Number of loaded events in this timeline. */
    eventCount: number;
    saveState: TimelineSaveState;
    saveError: string | null;
}>;

export type TimelineCreateDraft = Readonly<{
    id: string;
    createdAt: string;
    title: string;
    summary: string;
}>;

export type TimelineListIssue = Readonly<{ name: string; message: string }>;

export type TimelineListSnapshot = Readonly<{
    entries: readonly TimelineListEntry[];
    selectedId: string | null;
    createDraft: TimelineCreateDraft | null;
    issues: readonly TimelineListIssue[];
    loaded: boolean;
    loading: boolean;
    creating: boolean;
    busy: boolean;
    retryDisabled: boolean;
    error: string | null;
    retryLabel: string;
}>;

/** Stable commands and snapshots exposed to timeline navigation contributors. */
export type TimelineListModel = {
    getSnapshot(): TimelineListSnapshot;
    subscribe(listener: () => void): () => void;
    beginCreate(): TimelineCreateDraft | null;
    updateCreateDraft(values: { title?: string; summary?: string }): void;
    cancelCreate(): void;
    create(): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    save(id: string): Promise<boolean>;
    retry(): Promise<boolean>;
};

/** Timeline catalog and activation commands for plugins that contribute navigation UI. */
export type TimelineService = {
    /** A session-scoped model; null when no matching timeline project session is active. */
    getModel(sessionId: string): TimelineListModel | null;
    /** Select a timeline and display the timeline plugin's main content. */
    open(sessionId: string, timelineId: string): boolean;
};

export const timelineKey = createServiceKey<TimelineService>("app/timeline");
