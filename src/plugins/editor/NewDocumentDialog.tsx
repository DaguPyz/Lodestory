import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import type { TreeEntry } from "../../documents/documentApi";

type NewDocumentDialogProps = {
  projectName: string;
  entries: TreeEntry[];
  initialParent: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (parentPath: string, name: string) => Promise<void>;
};

function folders(entries: TreeEntry[]): TreeEntry[] {
  return entries.flatMap((entry) => entry.children ? [entry, ...folders(entry.children)] : []);
}

export function NewDocumentDialog({ projectName, entries, initialParent, busy, error, onClose, onCreate }: NewDocumentDialogProps) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState(initialParent);
  const input = useRef<HTMLInputElement>(null);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }} disablePointerDismissal={busy}>
      <Dialog.Portal>
        <Dialog.Backdrop className="project-dialog-backdrop" />
        <Dialog.Popup className="project-dialog" data-ui-density="comfortable" initialFocus={input}>
          <Dialog.Title className="project-dialog-title">新建文档</Dialog.Title>
          <Dialog.Description className="project-dialog-description">为新的章节或创作资料取个名字。</Dialog.Description>
          <form className="project-form" aria-busy={busy} onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) void onCreate(parentPath, name.trim());
          }}>
            <div className="project-form-field">
              <label htmlFor="new-document-name">文档名称</label>
              <input ref={input} id="new-document-name" name="documentName" value={name} onChange={(event) => setName(event.target.value)}
                aria-describedby="new-document-name-hint"
                required maxLength={255} autoComplete="off" placeholder="例如：第一章" disabled={busy} />
              <span id="new-document-name-hint" className="project-form-hint">默认使用 .md 格式，也可输入 .txt 后缀。</span>
            </div>
            <label className="project-form-field">
              <span>保存位置</span>
              <select name="documentParent" value={parentPath} onChange={(event) => setParentPath(event.target.value)} disabled={busy}>
                <option value="">{projectName}</option>
                {folders(entries).map((folder) => <option key={folder.path} value={folder.path}>{projectName}/{folder.path}</option>)}
              </select>
            </label>
            {error && <p className="project-error" role="alert">{error}</p>}
            <div className="project-dialog-actions">
              <Dialog.Close className="button button--secondary" disabled={busy}>取消</Dialog.Close>
              <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "正在创建…" : "创建文档"}</Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
