import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import type { PreviewDocument } from "./previewData";

type DocumentTabsProps = {
  documents: PreviewDocument[];
  activeDocument: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
};

export function DocumentTabs({ documents, activeDocument, onSelect, onClose }: DocumentTabsProps) {
  return (
    <nav className="document-tabs" aria-label="已打开的文稿">
      {documents.map((document) => (
        <div className="document-tab" key={document.id} data-active={document.id === activeDocument}>
          <button
            id={`document-tab-${document.id}`}
            className="document-tab-select"
            type="button"
            aria-current={document.id === activeDocument ? "page" : undefined}
            aria-controls={`editor-document-${document.id}`}
            title={document.fileName}
            onClick={() => onSelect(document.id)}
          >
            <Icon name="file" />
            <span>{document.fileName}</span>
          </button>
          <IconButton label={`关闭 ${document.fileName}`} onClick={() => onClose(document.id)}>
            <Icon name="close" size="small" />
          </IconButton>
        </div>
      ))}
    </nav>
  );
}
