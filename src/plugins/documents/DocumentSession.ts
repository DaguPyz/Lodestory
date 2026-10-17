import type {OpenDocument} from "@lodestory/sdk/documents";
import { documentErrorMessage, type DocumentRecord } from "./documentApi";

type WriteDocument = (path: string, content: string, expectedContent: string) => Promise<void>;

// Serialize writes for each document and retain edits made during an earlier save.
export class DocumentSession {
  private value: OpenDocument;
  private savedContent: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;

  constructor(record: DocumentRecord, private write: WriteDocument, private changed: () => void) {
    this.value = Object.freeze({ ...record, id: encodeURIComponent(record.path), saveState: "saved", saveError: null });
    this.savedContent = record.content;
  }

  get document(): OpenDocument { return this.value; }

  update(content: string) {
    if (this.value.content === content) return;
    this.value = Object.freeze({
      ...this.value, content, saveError: null,
      saveState: this.pending ? "saving" : content === this.savedContent ? "saved" : "pending",
    });
    this.notify();
    this.clearTimer();
    if (content !== this.savedContent) this.timer = setTimeout(() => { void this.save(); }, 700);
  }

  save(): Promise<boolean> {
    this.clearTimer();
    if (this.pending) return this.pending;
    // Install the promise before publishing save state, so subscriber reentry shares this write.
    let done!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { done = resolve; });
    this.pending = pending;
    const complete = (result: boolean) => {
      // An observer may edit during the saved notification or its following microtask.
      if (result && this.value.content !== this.savedContent) { void this.persist().then(complete, failed); return; }
      this.clearTimer();
      this.pending = null;
      done(result);
    };
    const failed = (error: unknown) => {
      this.value = Object.freeze({...this.value, saveState: "error", saveError: documentErrorMessage(error)});
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

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private notify() {
    try { this.changed(); }
    catch (error) { console.error("Document state notification failed.", {error}); }
  }

  private async persist(): Promise<boolean> {
    while (this.value.content !== this.savedContent) {
      const content = this.value.content;
      this.value = Object.freeze({ ...this.value, saveState: "saving", saveError: null });
      this.notify();
      try {
        await this.write(this.value.path, content, this.savedContent);
        this.savedContent = content;
      } catch (error) {
        this.value = Object.freeze({ ...this.value, saveState: "error", saveError: documentErrorMessage(error) });
        this.notify();
        return false;
      }
    }
    if (this.value.saveState !== "saved" || this.value.saveError !== null) {
      this.value = Object.freeze({ ...this.value, saveState: "saved", saveError: null });
      this.notify();
    }
    return true;
  }
}
