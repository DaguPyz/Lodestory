import {createServiceKey} from "./ServiceKey.js";

export type ProjectSaveState = "saved" | "pending" | "saving" | "error";
/** Frozen byte values (0–255); snapshots cannot be mutated through a typed-array view. */
export type ProjectFileBytes = readonly number[];
/** Compact immutable bytes. Reads copy into caller-owned memory; no mutable storage view escapes. */
export type ProjectByteView = Readonly<{
    byteLength: number;
    copyTo(target: Uint8Array, targetOffset?: number, sourceOffset?: number, length?: number): void;
    equals(data: ProjectFileData): boolean;
}>;
export type ProjectFileData = ProjectFileBytes | Uint8Array | ProjectByteView;
/** Opt-in representation; existing callers retain the frozen-array behavior. */
export type ProjectFileAccessOptions = Readonly<{preferByteView?: boolean}>;

/** One canonical byte buffer per project-relative path. No encoding or content format is implied. */
export type ProjectFile = Readonly<{
    path: string;
    fileName: string;
    bytes: ProjectFileBytes;
    /** Available for opt-in compact reads/writes; bytes remains a compatible, lazily materialized frozen array. */
    byteView?: ProjectByteView;
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
/** A committed project-relative move. Notifications are synchronous and informational; they cannot cancel or roll back the filesystem operation. */
export type ProjectPathRename = Readonly<{fromPath: string; toPath: string}>;
export type ProjectDirectoryListing = Readonly<{
    /** A missing directory has exists=false; access and read errors remain errors. */
    exists: boolean;
    entries: readonly ProjectDirectoryEntry[];
    issues: readonly Readonly<{ path: string; message: string }>[];
}>;
export type ProjectFileCreateOptions = Readonly<{
    preferByteView?: boolean;
    /** Explicit filesystem choice by the caller; no directory layout is inferred by storage. */
    createParents?: boolean;
    /** Recover an uncertain create only when the existing bytes are identical. Never replace other bytes. */
    acceptIdentical?: boolean;
}>;

export type ProjectFiles = {
    getSnapshot(): ProjectFileSnapshot;
    subscribe(listener: () => void): () => void;
    /** Optionally capture caller bytes as an immutable compact view without registering a file or scheduling a save. */
    captureBytes?(data: ProjectFileData): ProjectByteView;
    /** Refresh clean bytes from disk; preserve dirty or saving bytes. */
    read(path: string, options?: ProjectFileAccessOptions): Promise<ProjectFile | null>;
    /** Persist a new file at this exact path before publishing success. */
    create(path: string, bytes: ProjectFileData, options?: ProjectFileCreateOptions): Promise<ProjectFile | null>;
    /** Edit a buffer previously read/created and schedule autosave. Use save/saveState to observe persistence. */
    write(path: string, bytes: ProjectFileData, options?: ProjectFileAccessOptions): boolean;
    /** Flush the shared buffer. Explicit saves may finish during a project transition. */
    save(path: string): Promise<boolean>;
    saveAll(): Promise<boolean>;
    delete(path: string, options?: { discardChanges?: boolean }): Promise<boolean>;
    list(path: string): Promise<ProjectDirectoryListing | null>;
    createDirectory(path: string, options?: { recursive?: boolean }): Promise<boolean>;
    /** Rename a file or directory within the project after flushing affected buffers. Existing destinations are never replaced. */
    renamePath(fromPath: string, toPath: string): Promise<boolean>;
    /** Called synchronously after disk rename succeeds and before the file snapshot is remapped. Listeners cannot veto or roll back the rename. */
    subscribePathChanges(listener: (change: ProjectPathRename) => void): () => void;
    clearError(): void;
};

export type ProjectStorageService = {
    /** Stable file service for a live or staged project session; leaving or ended sessions return null. */
    getFiles(sessionId: string): ProjectFiles | null;
};

/** Owns byte buffers, write queues, autosave and conflict protection for project-relative files. */
export const projectStorageKey = createServiceKey<ProjectStorageService>("app/project-storage");
