import {useRef} from "react";
import { Button, Dialog, DialogActions, DialogClose } from "@lodestory/ui";

export function DeleteDocumentDialog({path, busy, error, onClose, onDelete}: {
  path: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title="删除文档" busy={busy}
    initialFocus={cancel} description={<>确定永久删除“{path}”吗？文档及未保存的修改将被删除，此操作无法撤销。</>}>
    {error && <p className="project-error" role="alert">{error}</p>}
    <DialogActions aria-busy={busy}>
      <DialogClose ref={cancel} disabled={busy}>取消</DialogClose>
      <Button variant="danger" data-delete-confirm disabled={busy} onClick={() => { if (!busy) void onDelete(); }}>
        {busy ? "正在删除…" : "删除文档"}
      </Button>
    </DialogActions>
  </Dialog>;
}
