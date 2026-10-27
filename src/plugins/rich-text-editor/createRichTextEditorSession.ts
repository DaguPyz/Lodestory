import type {EditorFormat, EditorHandle, EditorProps} from "@lodestory/sdk/body-editor";

export type RichTextEditorState = Readonly<{
  content: string;
  format: EditorFormat;
  readOnly: boolean;
  active: boolean;
}>;

export type RichTextEditorDriver = {
  create(): Promise<void>;
  destroy(): Promise<void>;
  getContent(): string;
  replaceContent(content: string, format: EditorFormat): void;
  setReadOnly(value: boolean): void;
  focus(): void;
  listen(listener: () => void): void;
};

/** Keeps persisted source text separate from Quill's normalized document snapshot. */
export function createRichTextEditorSession(
  driver: RichTextEditorDriver,
  initial: RichTextEditorState,
  callbacks: Pick<EditorProps, "onChange" | "onReady" | "onError">,
) {
  let state = initial;
  let propContent = initial.content;
  let desiredContent = initial.content;
  let acceptedContent = initial.content;
  let editorContent = initial.content;
  let alive = true;
  let ready = false;
  let failed = false;
  let syncing = false;
  let startPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  function asError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
  }

  function fail(reason: unknown) {
    if (!alive || failed) return;
    failed = true;
    if (ready) {
      ready = false;
      callbacks.onReady(null);
    }
    callbacks.onError(asError(reason));
  }

  function syncContent() {
    if (desiredContent === acceptedContent) return;
    if (desiredContent !== editorContent) {
      syncing = true;
      try {
        driver.replaceContent(desiredContent, state.format);
        editorContent = driver.getContent();
      } finally {
        syncing = false;
      }
    }
    acceptedContent = desiredContent;
  }

  const handle: EditorHandle = Object.freeze({
    focus() {
      if (!alive || !ready || !state.active) return;
      try { driver.focus(); }
      catch (error) { fail(error); }
    },
  });

  driver.listen(() => {
    if (!alive || !ready || failed || syncing || state.readOnly || !state.active) return;
    try {
      const content = driver.getContent();
      if (content === editorContent) return;
      editorContent = content;
      desiredContent = content;
      acceptedContent = content;
      callbacks.onChange(content);
    } catch (error) {
      fail(error);
    }
  });

  return {
    start(): Promise<void> {
      if (startPromise) return startPromise;
      if (!alive) return Promise.resolve();
      startPromise = (async () => {
        try {
          await driver.create();
          if (!alive) return;
          editorContent = driver.getContent();
          // The driver was seeded with initial.content. Props may have changed while it loaded.
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
    update(next: RichTextEditorState) {
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
    getContent(): string {
      if (!alive || !ready || failed) throw new Error("富文本编辑器尚未就绪。");
      return driver.getContent();
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      alive = false;
      disposePromise = (startPromise ?? Promise.resolve()).then(() => driver.destroy());
      if (ready) {
        ready = false;
        callbacks.onReady(null);
      }
      return disposePromise;
    },
  };
}
