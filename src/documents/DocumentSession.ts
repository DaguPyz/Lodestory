import { documentErrorMessage, type DocumentRecord, type WorkspaceDocument } from "./documentApi";

type WriteDocument = (path: string, content: string, expectedContent: string) => Promise<void>;

// Serialize writes for each document and retain edits made during an earlier save.
export class DocumentSession {
  private value: WorkspaceDocument;
  private savedContent: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;

  constructor(record: DocumentRecord, private write: WriteDocument, private changed: () => void) {
    this.value = { ...record, id: encodeURIComponent(record.path), saveState: "saved", saveError: null };
    this.savedContent = record.content;
  }

  get document(): WorkspaceDocument { return this.value; }

  update(content: string) {
    this.value = {
      ...this.value, content, saveError: null,
      saveState: this.pending ? "saving" : content === this.savedContent ? "saved" : "pending",
    };
    this.changed();
    this.clearTimer();
    if (content !== this.savedContent) this.timer = setTimeout(() => { void this.save(); }, 700);
  }

  save(): Promise<boolean> {
    this.clearTimer();
    if (this.pending) return this.pending;
    const pending = this.persist();
    this.pending = pending;
    void pending.finally(() => { this.pending = null; });
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

  private async persist(): Promise<boolean> {
    while (this.value.content !== this.savedContent) {
      const content = this.value.content;
      this.value = { ...this.value, saveState: "saving", saveError: null };
      this.changed();
      try {
        await this.write(this.value.path, content, this.savedContent);
        this.savedContent = content;
      } catch (error) {
        this.value = { ...this.value, saveState: "error", saveError: documentErrorMessage(error) };
        this.changed();
        return false;
      }
    }
    this.value = { ...this.value, saveState: "saved", saveError: null };
    this.changed();
    return true;
  }
}
