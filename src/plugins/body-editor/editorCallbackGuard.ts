import type {EditorHandle, EditorProps} from "@lodestory/sdk/body-editor";

type EditorSaveAsRequest = Parameters<NonNullable<EditorProps["onSaveAs"]>>[0];

export type EditorCallbackGuard = Readonly<{
  token: symbol;
  onChange(content: string): void;
  onReady(handle: EditorHandle | null): void;
  onError(error: Error): void;
  onSaveAs(request: EditorSaveAsRequest): Promise<void>;
  invalidate(): void;
}>;

/** Bind editor callbacks to one load attempt so stale instances cannot affect the host. */
export function createEditorCallbackGuard(
  token: symbol,
  isCurrent: (token: symbol) => boolean,
  handlers: {
    onChange(content: string): void;
    onReady(handle: EditorHandle | null): void;
    onError(error: Error): void;
    onSaveAs(request: EditorSaveAsRequest): Promise<void>;
  },
): EditorCallbackGuard {
  let valid = true;
  let hasHandle = false;
  const isValid = () => valid && isCurrent(token);
  return {
    token,
    onChange(content) {
      if (isValid()) handlers.onChange(content);
    },
    onReady(handle) {
      if (!isValid()) return;
      if (handle) {
        hasHandle = true;
        handlers.onReady(handle);
      } else if (hasHandle) {
        hasHandle = false;
        handlers.onReady(null);
      }
    },
    onError(error) {
      if (isValid()) handlers.onError(error);
    },
    async onSaveAs(request) {
      if (!isValid()) throw new Error("This editor instance is no longer active.");
      await handlers.onSaveAs(request);
    },
    invalidate() {
      if (!valid) return;
      const shouldClear = hasHandle && isCurrent(token);
      valid = false;
      hasHandle = false;
      if (shouldClear) handlers.onReady(null);
    },
  };
}
