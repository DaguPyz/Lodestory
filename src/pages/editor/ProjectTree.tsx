import type { CSSProperties } from "react";
import { IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { previewTree, type PreviewTreeNode } from "./previewData";

type ProjectTreeProps = {
  projectName: string;
  activeDocument: string | null;
  visible: boolean;
  overlay: boolean;
  onOpenDocument: (id: string) => void;
  onClose: () => void;
};

function TreeNode({
  node, depth, activeDocument, onOpenDocument,
}: {
  node: PreviewTreeNode;
  depth: number;
  activeDocument: string | null;
  onOpenDocument: (id: string) => void;
}) {
  const indentation = { "--cmp-tree-depth": depth } as CSSProperties;

  if (node.children) {
    return (
      <li>
        <details className="file-tree-folder" open={node.open}>
          <summary className="file-tree-entry" style={indentation} title={node.name}>
            <Icon name="chevronRight" size="small" />
            <Icon name="folder" />
            <span>{node.name}</span>
          </summary>
          <ul>
            {node.children.length > 0 ? node.children.map((child) => (
              <TreeNode
                key={child.id} node={child} depth={depth + 1}
                activeDocument={activeDocument} onOpenDocument={onOpenDocument}
              />
            )) : <li className="file-tree-empty" style={{ "--cmp-tree-depth": depth + 1 } as CSSProperties}>暂无文件</li>}
          </ul>
        </details>
      </li>
    );
  }

  const selected = node.documentId === activeDocument;
  return (
    <li>
      <button
        className="file-tree-entry file-tree-document"
        style={indentation}
        type="button"
        aria-current={selected ? "page" : undefined}
        title={node.name}
        onClick={() => { if (node.documentId) onOpenDocument(node.documentId); }}
      >
        <span className="file-tree-spacer" />
        <Icon name="file" />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

export function ProjectTree({ projectName, activeDocument, visible, overlay, onOpenDocument, onClose }: ProjectTreeProps) {
  return (
    <aside
      className="editor-project-panel"
      id="editor-project-tree"
      hidden={!visible}
      data-overlay={overlay}
      aria-label="项目文件"
    >
      <div className="editor-panel-header">
        <h2>项目</h2>
        <div className="editor-panel-actions">
          <IconButton label="新建文件" disabled><Icon name="plus" /></IconButton>
          <IconButton label="更多项目操作" disabled><Icon name="more" /></IconButton>
          {overlay && <IconButton label="收起项目文件" onClick={onClose}><Icon name="collapseLeft" /></IconButton>}
        </div>
      </div>
      <nav className="file-tree-scroll" aria-label="文件目录树">
        <ul className="file-tree">
          <TreeNode
            node={{ id: "root", name: projectName, open: true, children: previewTree }}
            depth={0}
            activeDocument={activeDocument}
            onOpenDocument={onOpenDocument}
          />
        </ul>
      </nav>
    </aside>
  );
}

