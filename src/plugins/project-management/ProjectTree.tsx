import { useEffect, useState, type CSSProperties } from "react";
import { Button, IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import type { ProjectTreeEntry } from "./projectManagementModel";
import { ContextMenuRegion } from "../context-menu";

type ProjectTreeProps = {
  projectName: string;
  entries: readonly ProjectTreeEntry[];
  activeDocumentPath: string | null;
  openingPath: string | null;
  loading: boolean;
  error: string | null;
  active: boolean;
  newDisabled: boolean;
  onOpenDocument: (path: string) => unknown | Promise<unknown>;
  onSelectFolder: (path: string) => void;
  onNewDocument: (parentPath?: string) => void;
  onReload: () => void;
};

function TreeNode({
  node, depth, activeDocumentPath, openingPath, expanded, onToggleFolder, onOpenDocument, onNewDocument, newDisabled, loading,
}: {
  node: ProjectTreeEntry;
  depth: number;
  activeDocumentPath: string | null;
  openingPath: string | null;
  expanded: Set<string>;
  onToggleFolder: (path: string) => void;
  onOpenDocument: (path: string) => unknown | Promise<unknown>;
  onNewDocument: (parentPath?: string) => void;
  newDisabled: boolean;
  loading: boolean;
}) {
  const indentation = { "--cmp-tree-depth": depth } as CSSProperties;

  if (node.children) {
    return (
      <li>
        <ContextMenuRegion context={node.path} label={`${node.name}目录操作`} items={[
          { id: "new-document", label: "新建文档", icon: <Icon name="plus" />, disabled: newDisabled, restoreFocus: false,
            onSelect: (path) => { if (!newDisabled && node.path === path) onNewDocument(path); } },
          { id: "toggle", label: expanded.has(node.path) ? "折叠" : "展开", disabled: loading,
            onSelect: (path) => { if (!loading && node.path === path) onToggleFolder(path); } },
        ]}>
          <button type="button" className="file-tree-entry file-tree-folder-toggle" style={indentation} title={node.name}
            disabled={loading}
            aria-expanded={expanded.has(node.path)} onClick={() => onToggleFolder(node.path)}>
            <Icon name="chevronRight" size="small" />
            <Icon name="folder" />
            <span>{node.name}</span>
          </button>
        </ContextMenuRegion>
        {expanded.has(node.path) && <ul>
          {node.children.length > 0 ? node.children.map((child) => (
            <TreeNode
              key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggleFolder={onToggleFolder}
              activeDocumentPath={activeDocumentPath} openingPath={openingPath} onOpenDocument={onOpenDocument}
              onNewDocument={onNewDocument} newDisabled={newDisabled} loading={loading}
            />
          )) : <li className="file-tree-empty" style={{ "--cmp-tree-depth": depth + 1 } as CSSProperties}>暂无文档</li>}
        </ul>}
      </li>
    );
  }

  const selected = node.path === activeDocumentPath;
  return (
    <li>
      <ContextMenuRegion context={node.path} label={`${node.name}文档操作`} items={[
        { id: "open", label: "打开文档", icon: <Icon name="file" />, disabled: loading || openingPath === node.path, restoreFocus: false,
          onSelect: (path) => { if (!loading && openingPath !== path && node.path === path) return onOpenDocument(path); } },
      ]}>
        <button
          className="file-tree-entry file-tree-document"
          style={indentation}
          type="button"
          disabled={loading}
          aria-current={selected ? "page" : undefined}
          aria-busy={openingPath === node.path}
          title={node.name}
          onClick={() => { if (!loading) void onOpenDocument(node.path); }}
        >
          <span className="file-tree-spacer" />
          <Icon name="file" />
          <span>{node.name}</span>
        </button>
      </ContextMenuRegion>
    </li>
  );
}

export function ProjectTree({ projectName, entries, activeDocumentPath, openingPath, loading, error, active, newDisabled,
  onOpenDocument, onSelectFolder, onNewDocument, onReload }: ProjectTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set([""]));
  const canInteract = active && !loading;

  useEffect(() => {
    if (!activeDocumentPath) return;
    const parts = activeDocumentPath.split("/");
    const parents = ["", ...parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"))];
    setExpanded((previous) => new Set([...previous, ...parents]));
  }, [activeDocumentPath]);

  function toggleFolder(path: string) {
    if (!canInteract) return;
    onSelectFolder(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  return (
    <aside
      className="project-management-panel"
      id="project-management-tree"
      aria-label="项目文件"
    >
      <div className="project-management-panel-header">
        <div className="project-management-panel-actions">
          <IconButton id="project-management-new-document" label="新建文档" disabled={!canInteract || newDisabled} onClick={() => onNewDocument()}><Icon name="plus" /></IconButton>
          <IconButton label="更多项目操作" disabled><Icon name="more" /></IconButton>
        </div>
      </div>
      <ContextMenuRegion label="文件目录树操作" disabled={!active} items={[
        { id: "new-document", label: "新建文档", icon: <Icon name="plus" />, disabled: newDisabled || !canInteract, restoreFocus: false,
          onSelect: () => { if (!newDisabled && canInteract) onNewDocument(""); } },
      ]}>
        <nav className="file-tree-scroll" aria-label="文件目录树" aria-busy={loading} tabIndex={0}>
          {loading && <p className="file-tree-message" role="status">正在读取文档…</p>}
          {error && <div className="file-tree-message" role="alert">
            <p className="project-error">{error}</p>
            <Button variant="ghost" disabled={!active} onClick={onReload}>重新加载</Button>
          </div>}
          {(!loading && !error || entries.length > 0) && <ul className="file-tree">
            <TreeNode
              node={{ path: "", name: projectName, children: entries }}
              depth={0} expanded={expanded} onToggleFolder={toggleFolder}
              activeDocumentPath={activeDocumentPath} openingPath={openingPath}
              onOpenDocument={(path) => { if (canInteract) return onOpenDocument(path); }}
              onNewDocument={(path) => { if (canInteract && !newDisabled) onNewDocument(path); }} newDisabled={newDisabled || !canInteract} loading={!canInteract}
            />
          </ul>}
        </nav>
      </ContextMenuRegion>
    </aside>
  );
}
