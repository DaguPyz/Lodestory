import { Icon } from "../../components/Icon";
import type { PreviewDocument } from "./previewData";

export function EditorStatusBar({ document }: { document: PreviewDocument | undefined }) {
  return (
    <footer className="editor-statusbar" aria-label="写作状态">
      <span className="editor-save-status"><Icon name="checkCircle" size="small" /><span>{document ? "已自动保存" : "未打开文稿"}</span></span>
      <div className="editor-document-status">
        {document && <span>{document.kind === "chapter" ? "本章" : "文稿"} {document.wordCount.toLocaleString("zh-CN")} 字</span>}
        <span className="editor-font-status">宋体 · 18</span>
        <span>100%</span>
      </div>
    </footer>
  );
}

