import type {EditorHandle} from "@lodestory/sdk/body-editor";

export type EditorCallbackGuard = Readonly<{
  token: symbol;
  onChange(content: string): void;
  onReady(handle: EditorHandle | null): void;
  onError(error: Error): void;
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
    invalidate() {
      if (!valid) return;
      const shouldClear = hasHandle && isCurrent(token);
      valid = false;
      hasHandle = false;
      if (shouldClear) handlers.onReady(null);
    },
  };
}
