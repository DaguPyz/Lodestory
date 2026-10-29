import type {EditorHandle, EditorProps, EditorSearchRange} from "@lodestory/sdk/body-editor";

export type MarkdownEditorState = Readonly<{
  content: string;
  readOnly: boolean;
  active: boolean;
}>;

export type MarkdownEditorDriver = {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
  getMarkdown(): string;
  replaceMarkdown(content: string): void;
  setReadOnly(value: boolean): void;
  focus(): void;
  revealSearchRange?(target: EditorSearchRange): boolean;
  listen(listener: (markdown: string) => void): void;
};

/** Keeps host content echoes separate from external document replacements. */
export function createMarkdownEditorSession(
  driver: MarkdownEditorDriver,
  initial: MarkdownEditorState,
  callbacks: Pick<EditorProps, "onChange" | "onReady" | "onError">,
) {
  let state = initial;
  let propContent = initial.content;
  let desiredContent = initial.content;
  let acceptedContent = initial.content;
  let markdown = initial.content;
  let alive = true;
  let ready = false;
  let failed = false;
  let syncing = false;
  let startPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  function fail(reason: unknown) {
    if (!alive || failed) return;
    failed = true;
    if (ready) {
      ready = false;
      callbacks.onReady(null);
    }
    callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
  }

  function syncContent() {
    if (desiredContent !== acceptedContent && desiredContent !== markdown) {
      syncing = true;
      try {
        driver.replaceMarkdown(desiredContent);
        markdown = driver.getMarkdown();
      } finally {
        syncing = false;
      }
    }
    acceptedContent = desiredContent;
  }

  const handle: EditorHandle = {
    focus() {
      if (!alive || !ready || !state.active) return;
      try { driver.focus(); }
      catch (error) { fail(error); }
    },
    revealSearchRange(target) {
      if (!alive || !ready || !state.active || !driver.revealSearchRange) return false;
      try { return driver.revealSearchRange(target); } catch { return false; }
    },
  };

  driver.listen(content => {
    if (!alive || !ready || failed || syncing || state.readOnly || !state.active) return;
    if (content === markdown) return;
    markdown = content;
    desiredContent = content;
    acceptedContent = content;
    try { callbacks.onChange(content); }
    catch (error) { fail(error); }
  });

  return {
    start(): Promise<void> {
      if (startPromise) return startPromise;
      if (!alive) return Promise.resolve();
      startPromise = (async () => {
        try {
          await driver.create();
          if (!alive) return;
          markdown = driver.getMarkdown();
          syncContent();
          driver.setReadOnly(state.readOnly || !state.active);
          ready = true;
          callbacks.onReady(handle);
        } catch (error) {
          fail(error);
        }
      })();
      return startPromise;
    },
    update(next: MarkdownEditorState) {
      if (!alive || failed) return;
      state = next;
      if (next.content !== propContent) {
        propContent = next.content;
        desiredContent = next.content;
      }
      if (!ready) return;
      try {
        driver.setReadOnly(next.readOnly || !next.active);
        syncContent();
      } catch (error) {
        fail(error);
      }
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      alive = false;
      disposePromise = (startPromise ?? Promise.resolve()).then(async () => {
        await driver.destroy();
      });
      if (ready) {
        ready = false;
        callbacks.onReady(null);
      }
      return disposePromise;
    },
  };
}
