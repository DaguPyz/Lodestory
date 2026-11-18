import { useLayoutEffect, useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogClose, Icon, TextField } from "@lodestory/ui";
import type { Translate } from "@lodestory/sdk/i18n";

type NewProjectDialogProps = {
  open?: boolean;
  busy: boolean;
  error: string | null;
  t?: Translate;
  onClose: () => void;
  onCloseComplete?: () => void;
  onPickDirectory: () => Promise<string | null | undefined>;
  onCreate: (parentPath: string, name: string) => Promise<void>;
};

export function NewProjectDialog({ open = true, busy, error, t, onClose, onCloseComplete, onPickDirectory, onCreate }: NewProjectDialogProps) {
  const text = (source: string) => t?.(source) ?? source;
  const title = text("新建项目");
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
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onCloseComplete?.(); }} title={title}
      moveLabel={t?.("移动弹框：{title}", {values: {title}})}
      moveHint={t?.("拖动标题移动；方向键移动，Shift 加速，Home 居中，拖动时按 Escape 取消。")}
      busy={busy} initialFocus={nameInput}>
      <form className="project-form" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (parentPath && name.trim() && !busy) void onCreate(parentPath, name.trim());
      }}>
        <label className="project-form-field">
          <span>{text("小说名称")}</span>
          <TextField ref={nameInput} name="projectName" value={name} onChange={(event) => setName(event.target.value)}
            required maxLength={255} autoComplete="off" placeholder={text("请输入小说名称")} disabled={busy} />
        </label>
        <div className="project-form-field">
          <label htmlFor="project-parent-path">{text("保存位置")}</label>
          <div className="project-directory-field">
            <TextField id="project-parent-path" value={parentPath} readOnly placeholder={text("选择父目录")} title={parentPath} />
            <Button variant="ghost" onClick={() => void chooseParent()} disabled={busy}><Icon name="folder" />{text("选择目录")}</Button>
          </div>
          <p className="project-form-hint">{text("将在此目录下创建与小说同名的文件夹。")}</p>
        </div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <DialogActions>
          <DialogClose disabled={busy}>{text("取消")}</DialogClose>
          <Button type="submit" variant="primary" disabled={busy || !parentPath || !name.trim()}>
            {text(busy ? "正在处理…" : "创建项目")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
