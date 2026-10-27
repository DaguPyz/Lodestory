import type {ProjectByteView, ProjectFile, ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";
import {storageErrorMessage, type FileRecord} from "./storageApi";
import {copyBytes} from "./bytes";
import {createProjectByteView, isOwnedProjectByteView, isProjectByteView, materializeProjectByteView, projectFileDataEquals} from "./byteView";

type CanonicalData = ProjectFileBytes | ProjectByteView;
type WriteBytes = (path: string, bytes: ProjectFileData, expectedBytes: ProjectFileData) => Promise<void>;

// Serialize writes for each canonical byte buffer and retain edits made during an earlier save.
export class FileSession {
  private value: ProjectFile;
  private currentData: CanonicalData;
  private savedData: CanonicalData;
  private savedArrayCache?: ProjectFileBytes;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;
  private deleting = false;
  private writeGeneration = 0;
  private acceptedWriteGeneration = 0;
  private readonly path: string;
  private readonly fileName: string;

  constructor(record: FileRecord, private persistBytes: WriteBytes, private changed: () => void, preferByteView = false) {
    this.path = record.path;
    this.fileName = record.fileName;
    this.currentData = preferByteView || isProjectByteView(record.bytes)
      ? createProjectByteView(record.bytes)
      : copyBytes(record.bytes);
    this.savedData = this.currentData;
    this.value = this.createFile(this.currentData, false, "saved", null);
  }

  get file(): ProjectFile { return this.value; }
  /** Legacy compatibility projection. It is materialized only when requested. */
  get persistedBytes(): ProjectFileBytes {
    if (!isOwnedProjectByteView(this.savedData)) return this.savedData as ProjectFileBytes;
    return this.savedArrayCache ??= materializeProjectByteView(this.savedData);
  }
  get persistedData(): ProjectFileData { return this.savedData; }
  get isByteViewMode(): boolean { return isOwnedProjectByteView(this.currentData); }
  get isDirty(): boolean { return !projectFileDataEquals(this.currentData, this.savedData); }

  /** An explicit opt-in can promote an already open session without changing its bytes or baseline. */
  useByteView() {
    if (this.isByteViewMode) return;
    const previousCurrent = this.currentData;
    const previousSaved = this.savedData;
    const current = createProjectByteView(previousCurrent);
    const saved = projectFileDataEquals(previousCurrent, previousSaved) ? current : createProjectByteView(previousSaved);
    this.currentData = current;
    this.savedData = saved;
    this.savedArrayCache = undefined;
    this.value = this.createFile(this.currentData, this.value.dirty, this.value.saveState, this.value.saveError);
    this.notify();
  }

  private promoteByteViewForWrite(current: ProjectByteView) {
    this.savedData = projectFileDataEquals(this.savedData, current) ? current : createProjectByteView(this.savedData);
    this.currentData = current;
    this.savedArrayCache = undefined;
  }

  write(data: ProjectFileData, options: {preferByteView?: boolean} = {}) {
    if (options.preferByteView !== undefined && typeof options.preferByteView !== "boolean") throw new Error("文件访问选项无效。");
    if (this.deleting) return;
    const generation = ++this.writeGeneration;
    const useByteView = options.preferByteView === true || this.isByteViewMode || isProjectByteView(data);
    const nextData = useByteView ? createProjectByteView(data) : copyBytes(data);
    // External iterators/view implementations may synchronously submit a newer edit while
    // being captured. Never install the older request after that newer write or deletion.
    if (generation < this.acceptedWriteGeneration || this.deleting) return;
    this.acceptedWriteGeneration = generation;
    const identical = projectFileDataEquals(this.currentData, nextData);
    const promoted = useByteView && !this.isByteViewMode;
    if (promoted) this.promoteByteViewForWrite(nextData as ProjectByteView);
    else if (identical) return;
    if (identical) {
      this.value = this.createFile(this.currentData, this.value.dirty, this.value.saveState, this.value.saveError);
      this.notify();
      return;
    }
    if (!promoted) this.currentData = nextData;
    const dirty = !projectFileDataEquals(nextData, this.savedData);
    this.value = this.createFile(nextData, dirty, this.pending ? "saving" : dirty ? "pending" : "saved", null);
    this.clearTimer();
    if (dirty) this.timer = setTimeout(() => { void this.save(); }, 700);
    this.notify();
  }

  save(): Promise<boolean> {
    this.clearTimer();
    if (this.pending) return this.pending;
    if (this.deleting) return Promise.resolve(false);
    // Install the promise before publishing save state, so subscriber reentry shares this write.
    let done!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { done = resolve; });
    this.pending = pending;
    const complete = (result: boolean) => {
      // An observer may edit during the saved notification or its following microtask.
      if (result && !this.deleting && !projectFileDataEquals(this.currentData, this.savedData)) { void this.persist().then(complete, failed); return; }
      if (!result) {
        this.pending = null;
        // An error listener may have accepted a newer edit while the failed promise
        // was still installed. Keep its autosave instead of stranding it as "saving".
        if (this.value.saveState === "saving") {
          const dirty = this.isDirty;
          this.value = this.createFile(this.currentData, dirty, dirty ? "pending" : "saved", null);
          if (!dirty) this.clearTimer();
          else if (!this.deleting && this.timer === null) this.timer = setTimeout(() => { void this.save(); }, 700);
          this.notify();
        } else this.clearTimer();
        done(false);
        return;
      }
      this.clearTimer();
      if (result && this.deleting && !projectFileDataEquals(this.currentData, this.savedData)) {
        this.value = this.createFile(this.currentData, true, "pending", null);
        this.notify();
      }
      this.pending = null;
      done(result);
    };
    const failed = (error: unknown) => {
      this.value = this.createFile(this.currentData, this.isDirty, "error", storageErrorMessage(error));
      this.notify();
      complete(false);
    };
    void this.persist().then(complete, failed);
    return pending;
  }

  dispose(): Promise<boolean> {
    this.clearTimer();
    // Switching works must not cancel a pending autosave.
    return this.save();
  }

  /** Lock edits/autosave and wait only for a write already accepted before deletion. */
  beginDelete(): Promise<boolean> {
    this.deleting = true;
    this.clearTimer();
    return this.pending ?? Promise.resolve(true);
  }

  /** Resume normal editing after a failed disk deletion. */
  cancelDelete(resumeAutosave = true) {
    if (!this.deleting) return;
    this.deleting = false;
    if (resumeAutosave && this.isDirty) this.timer = setTimeout(() => { void this.save(); }, 700);
  }

  /** Mark the session permanently removed without flushing a discarded draft. */
  finishDelete() {
    this.deleting = true;
    this.clearTimer();
  }

  private createFile(data: CanonicalData, dirty: boolean, saveState: ProjectFile["saveState"], saveError: string | null): ProjectFile {
    const metadata = {path: this.path, fileName: this.fileName, dirty, saveState, saveError};
    if (isOwnedProjectByteView(data)) {
      let bytes: ProjectFileBytes | undefined;
      return Object.freeze({
        ...metadata,
        get bytes() { return bytes ??= materializeProjectByteView(data); },
        byteView: data,
      });
    }
    return Object.freeze({...metadata, bytes: data as ProjectFileBytes});
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private notify() {
    try { this.changed(); }
    catch (error) { console.error("File buffer notification failed.", {error}); }
  }

  private async persist(): Promise<boolean> {
    while (!this.deleting && !projectFileDataEquals(this.currentData, this.savedData)) {
      const bytes = this.currentData;
      const expectedBytes = this.savedData;
      this.value = this.createFile(bytes, true, "saving", null);
      this.notify();
      try {
        await this.persistBytes(this.path, bytes, expectedBytes);
        this.savedData = this.isByteViewMode
          ? projectFileDataEquals(this.currentData, bytes) ? this.currentData as ProjectByteView : createProjectByteView(bytes)
          : bytes;
        this.savedArrayCache = undefined;
        const dirty = !projectFileDataEquals(this.currentData, this.savedData);
        this.value = this.createFile(this.currentData, dirty, "saving", null);
      } catch (error) {
        this.value = this.createFile(this.currentData, this.isDirty, "error", storageErrorMessage(error));
        this.notify();
        return false;
      }
    }
    if (!this.isDirty && (this.value.saveState !== "saved" || this.value.saveError !== null)) {
      this.value = this.createFile(this.currentData, false, "saved", null);
      this.notify();
    }
    return true;
  }
}
