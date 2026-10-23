import type {ProjectFile, ProjectFileBytes, ProjectFileData} from "@lodestory/sdk/project-storage";
import {storageErrorMessage, type FileRecord} from "./storageApi";
import {copyBytes, equalBytes} from "./bytes";

type WriteBytes = (path: string, bytes: ProjectFileBytes, expectedBytes: ProjectFileBytes) => Promise<void>;

// Serialize writes for each byte buffer and retain edits made during an earlier save.
export class FileSession {
  private value: ProjectFile;
  private savedBytes: ProjectFileBytes;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;
  private deleting = false;

  constructor(record: FileRecord, private persistBytes: WriteBytes, private changed: () => void) {
    const bytes = copyBytes(record.bytes);
    this.value = Object.freeze({ ...record, bytes, dirty: false, saveState: "saved", saveError: null });
    this.savedBytes = bytes;
  }

  get file(): ProjectFile { return this.value; }
  get persistedBytes(): ProjectFileBytes { return this.savedBytes; }
  get isDirty(): boolean { return !equalBytes(this.value.bytes, this.savedBytes); }

  write(data: ProjectFileData) {
    const bytes = copyBytes(data);
    if (this.deleting || equalBytes(this.value.bytes, bytes)) return;
    this.value = Object.freeze({
      ...this.value, bytes, dirty: !equalBytes(bytes, this.savedBytes), saveError: null,
      saveState: this.pending ? "saving" : equalBytes(bytes, this.savedBytes) ? "saved" : "pending",
    });
    this.notify();
    this.clearTimer();
    if (!equalBytes(bytes, this.savedBytes)) this.timer = setTimeout(() => { void this.save(); }, 700);
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
      if (result && !this.deleting && !equalBytes(this.value.bytes, this.savedBytes)) { void this.persist().then(complete, failed); return; }
      this.clearTimer();
      if (result && this.deleting && !equalBytes(this.value.bytes, this.savedBytes)) {
        this.value = Object.freeze({...this.value, saveState: "pending", saveError: null});
        this.notify();
      }
      this.pending = null;
      done(result);
    };
    const failed = (error: unknown) => {
      this.value = Object.freeze({...this.value, saveState: "error", saveError: storageErrorMessage(error)});
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

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private notify() {
    try { this.changed(); }
    catch (error) { console.error("File buffer notification failed.", {error}); }
  }

  private async persist(): Promise<boolean> {
    while (!this.deleting && !equalBytes(this.value.bytes, this.savedBytes)) {
      const bytes = this.value.bytes;
      this.value = Object.freeze({ ...this.value, saveState: "saving", saveError: null });
      this.notify();
      try {
        await this.persistBytes(this.value.path, bytes, this.savedBytes);
        this.savedBytes = bytes;
        this.value = Object.freeze({...this.value, dirty: !equalBytes(this.value.bytes, this.savedBytes)});
      } catch (error) {
        this.value = Object.freeze({ ...this.value, saveState: "error", saveError: storageErrorMessage(error) });
        this.notify();
        return false;
      }
    }
    if (equalBytes(this.value.bytes, this.savedBytes)
      && (this.value.saveState !== "saved" || this.value.saveError !== null)) {
      this.value = Object.freeze({ ...this.value, saveState: "saved", saveError: null });
      this.notify();
    }
    return true;
  }
}
