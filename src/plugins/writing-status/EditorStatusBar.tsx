import {useEffect, useMemo, useState, useSyncExternalStore} from "react";
import { Icon } from "@lodestory/ui";
import type {OpenDocument} from "@lodestory/sdk/documents";
import type {I18nService} from "@lodestory/sdk/i18n";
import {countDocumentCharacters} from "./countDocumentCharacters";
import {startChunkedCharacterCount} from "./chunkedCharacterCount";

const LARGE_TEXT_THRESHOLD = 1024 * 1024;
type AsyncCountResult = Readonly<{request: object; count?: number; failed?: true}>;
const saveStatusLabels = {saved: "已保存", pending: "等待保存…", saving: "正在保存…", error: "保存失败"};

export function EditorStatusBar({document, text, i18n, showDocumentDetails = true}: {
  document: OpenDocument | undefined;
  text?: string;
  i18n: I18nService;
  showDocumentDetails?: boolean;
}) {
  const {locale, t} = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const status = t(document ? saveStatusLabels[document.saveState] : "未打开文稿");
  const isLargeText = document !== undefined && text !== undefined && text.length >= LARGE_TEXT_THRESHOLD;
  const request = useMemo(() => ({}), [document?.id, text, showDocumentDetails, isLargeText]);
  const [asyncResult, setAsyncResult] = useState<AsyncCountResult | null>(null);
  useEffect(() => {
    if (!showDocumentDetails || !isLargeText || text === undefined) return;
    return startChunkedCharacterCount(text,
      count => setAsyncResult({request, count}),
      () => setAsyncResult({request, failed: true}));
  }, [request, showDocumentDetails, isLargeText, text]);

  const count = useMemo(() => {
    if (!showDocumentDetails || text === undefined || isLargeText) return undefined;
    return countDocumentCharacters(text);
  }, [showDocumentDetails, text, isLargeText]);
  const currentAsyncResult = isLargeText && asyncResult?.request === request ? asyncResult : null;
  const characterCount = count ?? currentAsyncResult?.count;
  const countLabel = characterCount !== undefined
    ? t("{count} 字", {count: characterCount, values: {count: number.format(characterCount)}})
    : isLargeText ? t(currentAsyncResult?.failed ? "统计失败" : "统计中…") : "—";
  return (
    <footer className="editor-statusbar" data-document-details-hidden={!showDocumentDetails || undefined} aria-label={t("写作状态")}>
      {showDocumentDetails && <span className="editor-save-status" role="status" data-state={document?.saveState}>
        <span className="editor-save-icon" aria-hidden="true">{document?.saveState === "saved" && <Icon name="checkCircle" size="small" />}</span><span>{status}</span>
      </span>}
      <div className="editor-document-status">
        {showDocumentDetails && document && <span>{t("文稿 {details}", {values: {details: countLabel}})}</span>}
        <span>100%</span>
      </div>
    </footer>
  );
}
