import { IconButton, Icon } from "@lodestory/ui";
import { ScrollArea } from "@base-ui/react/scroll-area";
import type {OpenDocument} from "@lodestory/sdk/documents";
import {ContextMenuRegion} from "../context-menu";

type DocumentTabsProps = {
  documents: readonly OpenDocument[];
  activeDocument: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => unknown | Promise<unknown>;
  onCloseMany: (ids: readonly string[]) => unknown | Promise<unknown>;
  onSave: (id: string) => unknown | Promise<unknown>;
  onNewDocument: () => void;
  newDisabled: boolean;
  disabled?: boolean;
};

export function DocumentTabs({documents, activeDocument, onSelect, onClose, onCloseMany, onSave, onNewDocument, newDisabled, disabled = false}: DocumentTabsProps) {
  if (documents.length === 0) return null;

  function closeDocuments(id: string, scope: "all" | "others" | "left" | "right") {
    const index = documents.findIndex(document => document.id === id);
    if (disabled || index < 0) return;
    const targets = scope === "all" ? documents
      : scope === "others" ? documents.filter(document => document.id !== id)
      : scope === "left" ? documents.slice(0, index)
      : documents.slice(index + 1);
    if (targets.length) return onCloseMany(targets.map(document => document.id));
  }

  return (
    <ContextMenuRegion label="文稿标签栏操作" items={[
      {id: "new-document", label: "新建文档", icon: <Icon name="plus"/>, disabled: newDisabled, restoreFocus: false,
        onSelect: () => { if (!newDisabled) onNewDocument(); }},
    ]}>
      <ScrollArea.Root className="document-tabs-shell">
      <ScrollArea.Viewport className="document-tabs" render={<nav aria-label="已打开的文稿"/>}
        style={{overflowX: "auto", overflowY: "hidden"}}>
      <ScrollArea.Content className="document-tabs-content">
        {documents.map((document, index) => (
          <ContextMenuRegion key={document.id} context={document.id} label={`${document.fileName}标签操作`} items={[
            {id: "save", label: "保存", disabled: disabled || document.saveState === "saving",
              onSelect: id => { if (!disabled && documents.some(record => record.id === id)) return onSave(id); }},
            {id: "close", label: "关闭", icon: <Icon name="close"/>, restoreFocus: false, disabled,
              onSelect: id => { if (!disabled && documents.some(record => record.id === id)) return onClose(id); }},
            {id: "batch-close-separator", type: "separator"},
            {id: "close-all", label: "关闭全部", restoreFocus: false, disabled,
              onSelect: id => closeDocuments(id, "all")},
            {id: "close-others", label: "关闭其他", restoreFocus: false, disabled: disabled || documents.length < 2,
              onSelect: id => closeDocuments(id, "others")},
            {id: "close-left", label: "关闭左侧", restoreFocus: false, disabled: disabled || index === 0,
              onSelect: id => closeDocuments(id, "left")},
            {id: "close-right", label: "关闭右侧", restoreFocus: false, disabled: disabled || index === documents.length - 1,
              onSelect: id => closeDocuments(id, "right")},
          ]}>
            <div className="document-tab" data-active={document.id === activeDocument}>
              <button
                className="document-tab-select"
                type="button"
                disabled={disabled}
                aria-current={document.id === activeDocument ? "page" : undefined}
                title={document.fileName}
                onClick={() => onSelect(document.id)}
              >
                <Icon name="file"/>
                <span>{document.fileName}</span>
                {document.saveState !== "saved" && <span className="document-tab-unsaved" aria-label="有未保存修改">●</span>}
              </button>
              <IconButton label={`关闭 ${document.fileName}`} disabled={disabled} onClick={() => onClose(document.id)}>
                <Icon name="close" size="small"/>
              </IconButton>
            </div>
          </ContextMenuRegion>
        ))}
      </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="document-tabs-scrollbar" orientation="horizontal">
        <ScrollArea.Thumb className="document-tabs-scrollbar-thumb"/>
      </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </ContextMenuRegion>
  );
}
