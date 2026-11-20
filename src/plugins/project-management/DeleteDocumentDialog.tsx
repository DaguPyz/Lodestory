import type {Translate} from "@lodestory/sdk/i18n";
import {useRef} from "react";
import { Button, Dialog, DialogActions, DialogClose } from "@lodestory/ui";

export function DeleteDocumentDialog({t, open = true, path, busy, error, onClose, onCloseComplete, onDelete}: {
  t: Translate;
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
    onOpenChangeComplete={nextOpen => { if (!nextOpen) onCloseComplete?.(); }} title={t("删除文档")} busy={busy}
    initialFocus={cancel} description={t("确定永久删除“{path}”吗？文档及未保存的修改将被删除，此操作无法撤销。", {values: {path}})}>
    {error && <p className="project-error" role="alert">{t(error)}</p>}
    <DialogActions aria-busy={busy}>
      <DialogClose ref={cancel} disabled={busy}>{t("取消")}</DialogClose>
      <Button variant="danger" data-delete-confirm disabled={busy} onClick={() => { if (!busy) void onDelete(); }}>
        {busy ? t("正在删除…") : t("删除文档")}
      </Button>
    </DialogActions>
  </Dialog>;
}
