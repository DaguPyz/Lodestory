import {useRef} from "react";
import { Button, Dialog, DialogActions, DialogClose } from "@lodestory/ui";

export function DeleteDocumentDialog({open = true, path, busy, error, onClose, onCloseComplete, onDelete}: {
  open?: boolean;
  path: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCloseComplete?: () => void;
  onDelete: () => Promise<void>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}
    onOpenChangeComplete={nextOpen => { if (!nextOpen) onCloseComplete?.(); }} title="删除文档" busy={busy}
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
