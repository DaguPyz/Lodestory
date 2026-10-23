import {createServiceKey} from "./ServiceKey.js";

export type ProjectSaveState = "saved" | "pending" | "saving" | "error";
/** Frozen byte values (0–255); snapshots cannot be mutated through a typed-array view. */
export type ProjectFileBytes = readonly number[];
export type ProjectFileData = ProjectFileBytes | Uint8Array;

/** One canonical byte buffer per project-relative path. No encoding or content format is implied. */
export type ProjectFile = Readonly<{
    path: string;
    fileName: string;
    bytes: ProjectFileBytes;
    dirty: boolean;
    saveState: ProjectSaveState;
    saveError: string | null;
}>;
export type ProjectFileSnapshot = Readonly<{
    files: readonly ProjectFile[];
    blocked: boolean;
    error: string | null;
}>;
export type ProjectDirectoryEntry = Readonly<{
    path: string;
    name: string;
    kind: "file" | "directory" | "symlink" | "other";
    size: number | null;
}>;
export type ProjectDirectoryListing = Readonly<{
    /** A missing directory has exists=false; access and read errors remain errors. */
    exists: boolean;
    entries: readonly ProjectDirectoryEntry[];
    issues: readonly Readonly<{ path: string; message: string }>[];
}>;
export type ProjectFileCreateOptions = Readonly<{
    /** Explicit filesystem choice by the caller; no directory layout is inferred by storage. */
    createParents?: boolean;
    /** Recover an uncertain create only when the existing bytes are identical. Never replace other bytes. */
    acceptIdentical?: boolean;
}>;

export type ProjectFiles = {
    getSnapshot(): ProjectFileSnapshot;
    subscribe(listener: () => void): () => void;
    /** Refresh clean bytes from disk; preserve dirty or saving bytes. */
    read(path: string): Promise<ProjectFile | null>;
    /** Persist a new file at this exact path before publishing success. */
    create(path: string, bytes: ProjectFileData, options?: ProjectFileCreateOptions): Promise<ProjectFile | null>;
    /** Edit a buffer previously read/created and schedule autosave. Use save/saveState to observe persistence. */
    write(path: string, bytes: ProjectFileData): boolean;
    /** Flush the shared buffer. Explicit saves may finish during a project transition. */
    save(path: string): Promise<boolean>;
    saveAll(): Promise<boolean>;
    delete(path: string, options?: { discardChanges?: boolean }): Promise<boolean>;
    list(path: string): Promise<ProjectDirectoryListing | null>;
    createDirectory(path: string, options?: { recursive?: boolean }): Promise<boolean>;
    clearError(): void;
};

export type ProjectStorageService = {
    /** Stable file service for a live or staged project session; leaving or ended sessions return null. */
    getFiles(sessionId: string): ProjectFiles | null;
};

/** Owns byte buffers, write queues, autosave and conflict protection for project-relative files. */
export const projectStorageKey = createServiceKey<ProjectStorageService>("app/project-storage");
