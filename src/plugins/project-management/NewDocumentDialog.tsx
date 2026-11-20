import type {Translate} from "@lodestory/sdk/i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { Dialog, TextField } from "@lodestory/ui";
import type { CreateEntryKind } from "./projectManagementModel";

type NewDocumentDialogProps = {
  t: Translate;
  open?: boolean;
  initialParent: string;
  kind?: CreateEntryKind;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCloseComplete?: () => void;
  onCreate: (parentPath: string, name: string) => Promise<void>;
};

export function NewDocumentDialog({t, open = true, initialParent, kind = "document", busy, error, onClose, onCloseComplete, onCreate }: NewDocumentDialogProps) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState(initialParent);
  const previousOpen = useRef(open);
  const input = useRef<HTMLInputElement>(null);
  const directory = kind === "directory";
  const title = directory ? t("新建文件夹") : t("新建文档");

  useLayoutEffect(() => {
    if (open && !previousOpen.current) {
      setName("");
      setParentPath(initialParent);
    }
    previousOpen.current = open;
  }, [initialParent, open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onCloseComplete?.(); }} title={title}
      busy={busy} initialFocus={input}>
      <form className="project-form" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !busy) void onCreate(parentPath, name.trim());
      }}>
        <div className="project-form-field">
          <TextField ref={input} id="new-document-name" name="documentName" value={name} onChange={(event) => setName(event.target.value)}
            aria-label={directory ? t("文件夹名称") : t("文档名称")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
            required maxLength={255} autoComplete="off" placeholder={directory ? t("例如：人物设定") : t("例如：第一章")} disabled={busy} />
        </div>
        {error && <p className="project-error" role="alert">{t(error)}</p>}
      </form>
    </Dialog>
  );
}
