import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import type { OpenDocument } from "@lodestory/sdk/documents";
import { ContextMenuRegion } from "../context-menu";

type DocumentTabsProps = {
  documents: readonly OpenDocument[];
  activeDocument: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => unknown | Promise<unknown>;
  onSave: (id: string) => unknown | Promise<unknown>;
  onNewDocument: () => void;
  newDisabled: boolean;
  disabled?: boolean;
};

export function DocumentTabs({ documents, activeDocument, onSelect, onClose, onSave, onNewDocument, newDisabled, disabled = false }: DocumentTabsProps) {
  return (
    <ContextMenuRegion label="文稿标签栏操作" items={[
      { id: "new-document", label: "新建文档", icon: <Icon name="plus" />, disabled: newDisabled, restoreFocus: false,
        onSelect: () => { if (!newDisabled) onNewDocument(); } },
    ]}>
    <nav className="document-tabs" aria-label="已打开的文稿" tabIndex={0}>
      {documents.map((document) => (
        <ContextMenuRegion key={document.id} context={document.id} label={`${document.fileName}标签操作`} items={[
          { id: "save", label: "保存", disabled: document.saveState === "saving",
            onSelect: (id) => { if (documents.some((record) => record.id === id)) return onSave(id); } },
          { id: "close", label: "关闭", icon: <Icon name="close" />, restoreFocus: false, disabled,
            onSelect: (id) => { if (!disabled && documents.some((record) => record.id === id)) return onClose(id); } },
        ]}>
        <div className="document-tab" data-active={document.id === activeDocument}>
          <button
            id={`document-tab-${document.id}`}
            className="document-tab-select"
            type="button"
            disabled={disabled}
            aria-current={document.id === activeDocument ? "page" : undefined}
            aria-controls={`editor-document-${document.id}`}
            title={document.fileName}
            onClick={() => onSelect(document.id)}
          >
            <Icon name="file" />
            <span>{document.fileName}</span>
            {document.saveState !== "saved" && <span className="document-tab-unsaved" aria-label="有未保存修改">●</span>}
          </button>
          <IconButton label={`关闭 ${document.fileName}`} disabled={disabled} onClick={() => onClose(document.id)}>
            <Icon name="close" size="small" />
          </IconButton>
        </div>
        </ContextMenuRegion>
      ))}
    </nav>
    </ContextMenuRegion>
  );
}
