import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { previewPeople } from "./previewData";

export function ReferencePanel({ visible, overlay, onClose }: { visible: boolean; overlay: boolean; onClose: () => void }) {
  return (
    <aside className="editor-reference" id="editor-reference" hidden={!visible} data-overlay={overlay} aria-labelledby="editor-reference-heading">
      <div className="editor-panel-header">
        <h2 id="editor-reference-heading">参考资料</h2>
        <IconButton label="收起参考资料" onClick={onClose}><Icon name="collapseRight" /></IconButton>
      </div>
      <div className="reference-scroll">
        <div className="reference-source">
          <Icon name="file" />
          <span title="人物设定.md">人物设定.md</span>
          <span className="reference-readonly">只读</span>
        </div>
        <div className="reference-content">
          {previewPeople.map((person) => (
            <section className="reference-person" key={person.name}>
              <h3>{person.name}</h3>
              <p>{person.description}</p>
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}

