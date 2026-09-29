import { useEffect, useState, type CSSProperties } from "react";
import { Button, IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import type { TreeEntry } from "../../documents/documentApi";

type ProjectTreeProps = {
  projectName: string;
  entries: TreeEntry[];
  activeDocument: string | null;
  openingPath: string | null;
  loading: boolean;
  error: string | null;
  newDisabled: boolean;
  visible: boolean;
  overlay: boolean;
  onOpenDocument: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onNewDocument: () => void;
  onReload: () => void;
  onClose: () => void;
};

function TreeNode({
  node, depth, activeDocument, openingPath, expanded, onToggleFolder, onOpenDocument,
}: {
  node: TreeEntry;
  depth: number;
  activeDocument: string | null;
  openingPath: string | null;
  expanded: Set<string>;
  onToggleFolder: (path: string) => void;
  onOpenDocument: (path: string) => void;
}) {
  const indentation = { "--cmp-tree-depth": depth } as CSSProperties;

  if (node.children) {
    return (
      <li>
        <button type="button" className="file-tree-entry file-tree-folder-toggle" style={indentation} title={node.name}
          aria-expanded={expanded.has(node.path)} onClick={() => onToggleFolder(node.path)}>
          <Icon name="chevronRight" size="small" />
          <Icon name="folder" />
          <span>{node.name}</span>
        </button>
        {expanded.has(node.path) && <ul>
          {node.children.length > 0 ? node.children.map((child) => (
            <TreeNode
              key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggleFolder={onToggleFolder}
              activeDocument={activeDocument} openingPath={openingPath} onOpenDocument={onOpenDocument}
            />
          )) : <li className="file-tree-empty" style={{ "--cmp-tree-depth": depth + 1 } as CSSProperties}>暂无文档</li>}
        </ul>}
      </li>
    );
  }

  const selected = encodeURIComponent(node.path) === activeDocument;
  return (
    <li>
      <button
        className="file-tree-entry file-tree-document"
        style={indentation}
        type="button"
        aria-current={selected ? "page" : undefined}
        aria-busy={openingPath === node.path}
        title={node.name}
        onClick={() => onOpenDocument(node.path)}
      >
        <span className="file-tree-spacer" />
        <Icon name="file" />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

export function ProjectTree({ projectName, entries, activeDocument, openingPath, loading, error, newDisabled,
  visible, overlay, onOpenDocument, onSelectFolder, onNewDocument, onReload, onClose }: ProjectTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set([""]));

  useEffect(() => {
    if (!activeDocument) return;
    const parts = decodeURIComponent(activeDocument).split("/");
    const parents = ["", ...parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"))];
    setExpanded((previous) => new Set([...previous, ...parents]));
  }, [activeDocument]);

  function toggleFolder(path: string) {
    onSelectFolder(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

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
          <IconButton id="editor-new-document" label="新建文档" disabled={newDisabled} onClick={onNewDocument}><Icon name="plus" /></IconButton>
          <IconButton label="更多项目操作" disabled><Icon name="more" /></IconButton>
          {overlay && <IconButton label="收起项目文件" onClick={onClose}><Icon name="collapseLeft" /></IconButton>}
        </div>
      </div>
      <nav className="file-tree-scroll" aria-label="文件目录树" aria-busy={loading}>
        {loading && <p className="file-tree-message" role="status">正在读取文档…</p>}
        {error && <div className="file-tree-message" role="alert">
          <p className="project-error">{error}</p>
          <Button variant="ghost" onClick={onReload}>重新加载</Button>
        </div>}
        {(!loading && !error || entries.length > 0) && <ul className="file-tree">
          <TreeNode
            node={{ path: "", name: projectName, children: entries }}
            depth={0} expanded={expanded} onToggleFolder={toggleFolder}
            activeDocument={activeDocument} openingPath={openingPath}
            onOpenDocument={onOpenDocument}
          />
        </ul>}
      </nav>
    </aside>
  );
}
