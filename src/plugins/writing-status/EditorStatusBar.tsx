import { Icon } from "@lodestory/ui";
import type {OpenDocument} from "@lodestory/sdk/documents";

export function EditorStatusBar({document, text, showDocumentDetails = true}: {
  document: OpenDocument | undefined;
  text?: string;
  showDocumentDetails?: boolean;
}) {
  const status = document ? {saved: "已保存", pending: "等待保存…", saving: "正在保存…", error: "保存失败"}[document.saveState] : "未打开文稿";
  const count = text === undefined ? undefined : Array.from(text.replace(/\s/g, "")).length;
  return (
    <footer className="editor-statusbar" data-document-details-hidden={!showDocumentDetails || undefined} aria-label="写作状态">
      {showDocumentDetails && <span className="editor-save-status" role="status" data-state={document?.saveState}>
        <span className="editor-save-icon" aria-hidden="true">{document?.saveState === "saved" && <Icon name="checkCircle" size="small" />}</span><span>{status}</span>
      </span>}
      <div className="editor-document-status">
        {showDocumentDetails && document && <span>文稿 {count === undefined ? "—" : `${count.toLocaleString("zh-CN")} 字`}</span>}
        <span>100%</span>
      </div>
    </footer>
  );
}
