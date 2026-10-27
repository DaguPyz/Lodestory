import type {RichTextEditorDriver} from "./createRichTextEditorSession";

// Decide once per open editor. Shrinking a large document must not replace its undo history.
export function needsVirtualPlainText(content: string): boolean {
  if (content.length >= 256 * 1024) return true;
  let lines = 1;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10 && ++lines >= 5000) return true;
    if (content.charCodeAt(index) === 13) {
      if (content.charCodeAt(index + 1) === 10) index++;
      if (++lines >= 5000) return true;
    }
  }
  return false;
}

/** Keeps the viewport editor out of ordinary Quill loading and uses the same session protocol. */
export function createLazyPlainTextDriver(root: HTMLElement, content: string): RichTextEditorDriver & {
  setFontFamilies(families: readonly string[]): void;
} {
  let implementation: RichTextEditorDriver | undefined;
  let listener: () => void = () => {};
  let disposed = false;
  return {
    async create() {
      const {createLargePlainTextDriver} = await import("./largePlainTextDriver");
      if (disposed) return;
      const driver = createLargePlainTextDriver(root, content);
      implementation = driver;
      driver.listen(listener);
      try { await driver.create(); }
      catch (error) { await driver.destroy(); throw error; }
    },
    async destroy() {
      disposed = true;
      await implementation?.destroy();
      implementation = undefined;
    },
    getContent() {
      if (!implementation) throw new Error("纯文本编辑器尚未就绪。");
      return implementation.getContent();
    },
    replaceContent(value, format) {
      if (!implementation) throw new Error("纯文本编辑器尚未就绪。");
      implementation.replaceContent(value, format);
    },
    setReadOnly(value) { implementation?.setReadOnly(value); },
    setFontFamilies() {},
    focus() { implementation?.focus(); },
    listen(value) { listener = value; implementation?.listen(value); },
  };
}
