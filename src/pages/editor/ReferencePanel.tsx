import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";

export function ReferencePanel({ visible, overlay, onClose }: { visible: boolean; overlay: boolean; onClose: () => void }) {
  return (
    <aside className="editor-reference" id="editor-reference" hidden={!visible} data-overlay={overlay} aria-labelledby="editor-reference-heading">
      <div className="editor-panel-header">
        <h2 id="editor-reference-heading">参考资料</h2>
        <IconButton label="收起参考资料" onClick={onClose}><Icon name="collapseRight" /></IconButton>
      </div>
      <div className="reference-scroll">
        <p className="reference-empty">参考资料尚未接入。</p>
      </div>
    </aside>
  );
}
