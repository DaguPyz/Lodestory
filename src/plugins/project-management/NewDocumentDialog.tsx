import { useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogClose, Select } from "@lodestory/ui";
import type { CreateEntryKind, DocumentExtension, ProjectTreeEntry } from "./projectManagementModel";

type NewDocumentDialogProps = {
  projectName: string;
  entries: readonly ProjectTreeEntry[];
  initialParent: string;
  kind?: CreateEntryKind;
  extension?: DocumentExtension | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (parentPath: string, name: string) => Promise<void>;
};

function folders(entries: readonly ProjectTreeEntry[]): ProjectTreeEntry[] {
  return entries.flatMap((entry) => entry.children ? [entry, ...folders(entry.children)] : []);
}

export function NewDocumentDialog({ projectName, entries, initialParent, kind = "document", extension, busy, error, onClose, onCreate }: NewDocumentDialogProps) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState(initialParent);
  const input = useRef<HTMLInputElement>(null);
  const directory = kind === "directory";
  const title = directory ? "新建文件夹" : extension ? `新建 ${extension === "lode" ? "富文本" : extension.toUpperCase()} 文档` : "新建文档";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={title}
      description={directory ? "创建文件夹，整理章节和创作资料。" : "为新的章节或创作资料取个名字。"}
      busy={busy} initialFocus={input}>
      <form className="project-form" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !busy) void onCreate(parentPath, name.trim());
      }}>
        <div className="project-form-field">
          <label htmlFor="new-document-name">{directory ? "文件夹名称" : "文档名称"}</label>
          <input ref={input} id="new-document-name" name="documentName" value={name} onChange={(event) => setName(event.target.value)}
            aria-describedby="new-document-name-hint"
            required maxLength={255} autoComplete="off" placeholder={directory ? "例如：人物设定" : "例如：第一章"} disabled={busy} />
          <span id="new-document-name-hint" className="project-form-hint">{directory ? "文件夹将创建在所选位置。" : extension ? `将保存为 .${extension} 格式，无需输入后缀。` : "默认使用 .md 格式，也可输入 .txt 或 .lode 后缀。"}</span>
        </div>
        <div className="project-form-field">
          <span id="new-document-parent-label">保存位置</span>
          <Select name="documentParent" aria-labelledby="new-document-parent-label" value={parentPath}
            onValueChange={setParentPath} disabled={busy}
            options={[{value: "", label: projectName}, ...folders(entries).map(folder => ({
              value: folder.path,
              label: `${projectName}/${folder.path}`,
            }))]} />
        </div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <DialogActions>
          <DialogClose disabled={busy}>取消</DialogClose>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "正在创建…" : directory ? "创建文件夹" : "创建文档"}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
