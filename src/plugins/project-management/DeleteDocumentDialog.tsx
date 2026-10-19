import {Dialog} from "@base-ui/react/dialog";
import {useRef} from "react";
import {Button} from "../../components/Button";

export function DeleteDocumentDialog({path, busy, error, onClose, onDelete}: {
  path: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }} disablePointerDismissal={busy}>
    <Dialog.Portal>
      <Dialog.Backdrop className="project-dialog-backdrop" />
      <Dialog.Popup className="project-dialog" data-ui-density="comfortable" initialFocus={cancel}>
        <Dialog.Title className="project-dialog-title">删除文档</Dialog.Title>
        <Dialog.Description className="project-dialog-description project-delete-description">
          确定永久删除“{path}”吗？文档及未保存的修改将被删除，此操作无法撤销。
        </Dialog.Description>
        {error && <p className="project-error" role="alert">{error}</p>}
        <div className="project-dialog-actions" aria-busy={busy}>
          <Dialog.Close ref={cancel} className="button button--secondary" disabled={busy}>取消</Dialog.Close>
          <Button variant="secondary" data-delete-confirm disabled={busy} onClick={() => { if (!busy) void onDelete(); }}>
            {busy ? "正在删除…" : "删除文档"}
          </Button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
