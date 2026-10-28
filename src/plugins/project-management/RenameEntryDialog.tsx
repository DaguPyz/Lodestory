import {useLayoutEffect, useRef, useState} from "react";
import {Button, Dialog, DialogActions, DialogClose, TextField} from "@lodestory/ui";

export function RenameEntryDialog({open, name, suffix, directory, busy, error, onClose, onCloseComplete, onRename}: {
  open: boolean;
  name: string;
  suffix: string;
  directory: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCloseComplete?: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const previousOpen = useRef(open);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (open && !previousOpen.current) setValue(name);
    previousOpen.current = open;
  }, [name, open]);

  return <Dialog open={open} onOpenChange={next => {if (!next) onClose();}}
    onOpenChangeComplete={next => {if (!next) onCloseComplete?.();}}
    title={directory ? "重命名文件夹" : "重命名文件"} busy={busy} initialFocus={input}>
    <form className="project-form" aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (value.trim() && !busy) void onRename(value.trim());
    }}>
      <div className="project-form-field">
        <TextField ref={input} id="rename-entry-name" name="entryName" value={value}
          onChange={event => setValue(event.target.value)} aria-label={directory ? "新文件夹名称" : "新文件名"}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
          }} required maxLength={255} autoComplete="off" placeholder={directory ? "文件夹名称" : "文件名"} disabled={busy}/>
        {!directory && suffix && <p className="project-form-hint">文件扩展名 {suffix} 将保留。</p>}
      </div>
      {error && <p className="project-error" role="alert">{error}</p>}
      <DialogActions>
        <DialogClose disabled={busy}>取消</DialogClose>
        <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "正在重命名…" : "重命名"}
        </Button>
      </DialogActions>
    </form>
  </Dialog>;
}
