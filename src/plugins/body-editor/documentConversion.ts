import type {EditorFormat, EditorHandle} from "@lodestory/sdk/body-editor";
import type {ResolvedEditorConversion} from "./bodyEditorRegistry";

export type DocumentConversionState = Readonly<{
  documentId: string;
  format?: EditorFormat;
  content: string;
  handle?: EditorHandle | null;
  visible: boolean;
  active: boolean;
  readOnly: boolean;
  saveState: string;
  conversions: readonly ResolvedEditorConversion[];
  onSaveAs?: (request: Readonly<{extension: string; content: string}>) => Promise<void>;
}>;

export type DocumentConversionStatus = Readonly<{key?: string; busy: boolean; error?: string}>;

/** Coordinates host-owned conversion saves and ignores actions from an outdated document view. */
export function createDocumentConversionController(
  getState: () => DocumentConversionState,
  setStatus: (status: DocumentConversionStatus) => void,
) {
  let locked = false;
  let generation = 0;

  return {
    isLocked: () => locked,
    invalidate() {
      generation++;
      locked = false;
    },
    async run(documentId: string, conversionKey: string) {
      if (locked) return;
      const state = getState();
      const conversion = state.conversions.find(candidate => candidate.key === conversionKey);
      if (state.documentId !== documentId || !conversion || state.format !== conversion.from
        || !state.onSaveAs || !state.visible || !state.active || state.readOnly || state.saveState === "saving") return;

      locked = true;
      const request = ++generation;
      let failure: string | undefined;
      setStatus({key: conversion.key, busy: true});
      try {
        const source = state.handle?.flushContent?.(state.content) ?? state.content;
        const content = conversion.convert(source);
        if (typeof content !== "string") throw new TypeError("转换器必须返回文档内容字符串。");
        const latest = getState();
        if (latest.documentId !== documentId || latest.format !== conversion.from || !latest.onSaveAs
          || !latest.visible || !latest.active || latest.readOnly
          || !latest.conversions.some(candidate => candidate.key === conversion.key
            && candidate.extension === conversion.extension && candidate.convert === conversion.convert)) return;
        await latest.onSaveAs({extension: conversion.extension, content});
      } catch (error) {
        if (generation === request && getState().documentId === documentId) {
          failure = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (generation === request) {
          locked = false;
          const latest = getState();
          if (latest.documentId === documentId) setStatus({key: conversion.key, busy: false, ...(failure ? {error: failure} : {})});
        }
      }
    },
  };
}
