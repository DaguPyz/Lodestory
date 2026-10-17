import { Icon } from "../../components/Icon";
import type { OpenDocument } from "@lodestory/sdk/documents";

export function EditorStatusBar({ document }: { document: OpenDocument | undefined }) {
  const status = document ? { saved: "已保存", pending: "等待保存…", saving: "正在保存…", error: "保存失败" }[document.saveState] : "未打开文稿";
  const count = document ? Array.from(document.content.replace(/\s/g, "")).length : 0;
  return (
    <footer className="editor-statusbar" aria-label="写作状态">
      <span className="editor-save-status" role="status" data-state={document?.saveState}>
        {document?.saveState === "saved" && <Icon name="checkCircle" size="small" />}<span>{status}</span>
      </span>
      <div className="editor-document-status">
        {document && <span>文稿 {count.toLocaleString("zh-CN")} 字</span>}
        <span className="editor-font-status">宋体 · 18</span>
        <span>100%</span>
      </div>
    </footer>
  );
}
