import { useLayoutEffect, useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogClose, Icon, TextField } from "@lodestory/ui";

type NewProjectDialogProps = {
  open?: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCloseComplete?: () => void;
  onPickDirectory: () => Promise<string | null | undefined>;
  onCreate: (parentPath: string, name: string) => Promise<void>;
};

export function NewProjectDialog({ open = true, busy, error, onClose, onCloseComplete, onPickDirectory, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const previousOpen = useRef(open);
  const nameInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (open && !previousOpen.current) {
      setName("");
      setParentPath("");
    }
    previousOpen.current = open;
  }, [open]);

  async function chooseParent() {
    const selected = await onPickDirectory();
    if (selected) setParentPath(selected);
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onCloseComplete?.(); }} title="新建项目"
      busy={busy} initialFocus={nameInput}>
      <form className="project-form" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (parentPath && name.trim() && !busy) void onCreate(parentPath, name.trim());
      }}>
        <label className="project-form-field">
          <span>小说名称</span>
          <TextField ref={nameInput} name="projectName" value={name} onChange={(event) => setName(event.target.value)}
            required maxLength={255} autoComplete="off" placeholder="请输入小说名称" disabled={busy} />
        </label>
        <div className="project-form-field">
          <label htmlFor="project-parent-path">保存位置</label>
          <div className="project-directory-field">
            <TextField id="project-parent-path" value={parentPath} readOnly placeholder="选择父目录" title={parentPath} />
            <Button onClick={() => void chooseParent()} disabled={busy}><Icon name="folder" />选择目录</Button>
          </div>
          <p className="project-form-hint">将在此目录下创建与小说同名的文件夹。</p>
        </div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <DialogActions>
          <DialogClose disabled={busy}>取消</DialogClose>
          <Button type="submit" variant="primary" disabled={busy || !parentPath || !name.trim()}>
            {busy ? "正在处理…" : "创建项目"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
