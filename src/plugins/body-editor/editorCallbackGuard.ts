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
  let currentHandle: EditorHandle | null = null;
  let exposedHandle: EditorHandle | null = null;
  const isValid = () => valid && isCurrent(token);

  function exposeHandle(handle: EditorHandle): EditorHandle {
    if (currentHandle === handle && exposedHandle) return exposedHandle;
    currentHandle = handle;
    const getActions = handle.getContextMenuActions;
    exposedHandle = getActions || handle.flushContent || handle.revealSearchRange ? {
      focus() {
        if (isValid() && currentHandle === handle) handle.focus();
      },
      ...(handle.flushContent ? {flushContent(currentContent?: string) {
        if (!isValid() || currentHandle !== handle) throw new Error("This editor instance is no longer active.");
        return handle.flushContent!(currentContent);
      }} : {}),
      ...(handle.revealSearchRange ? {revealSearchRange(target: Parameters<NonNullable<EditorHandle["revealSearchRange"]>>[0]) {
        return isValid() && currentHandle === handle ? handle.revealSearchRange!(target) : false;
      }} : {}),
      ...(getActions ? {getContextMenuActions() {
        if (!isValid() || currentHandle !== handle) return [];
        return getActions.call(handle).map(action => ({
          ...action,
          run() {
            if (!isValid() || currentHandle !== handle) return;
            return action.run();
          },
        }));
      }} : {}),
    } : handle;
    return exposedHandle;
  }

  return {
    token,
    onChange(content) {
      if (isValid()) handlers.onChange(content);
    },
    onReady(handle) {
      if (!isValid()) return;
      if (handle) {
        hasHandle = true;
        handlers.onReady(exposeHandle(handle));
      } else if (hasHandle) {
        hasHandle = false;
        currentHandle = null;
        exposedHandle = null;
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
      currentHandle = null;
      exposedHandle = null;
      if (shouldClear) handlers.onReady(null);
    },
  };
}
