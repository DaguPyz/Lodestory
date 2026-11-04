import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Button, IconButton, Icon } from "@lodestory/ui";
import {shortcutCommandIds, shortcutScopeIds, type ShortcutsService} from "@lodestory/sdk/shortcuts";
import type { DocumentExtension, ProjectTreeEntry } from "./projectManagementModel";
import { ContextMenuRegion, type MenuEntry } from "../context-menu";

type ProjectTreeProps = {
  shortcuts: ShortcutsService;
  projectName: string;
  entries: readonly ProjectTreeEntry[];
  activeDocumentPath: string | null;
  openingPath: string | null;
  loading: boolean;
  error: string | null;
  active: boolean;
  newDisabled: boolean;
  deletingPath: string | null;
  lastRename: Readonly<{fromPath: string; toPath: string; directory: boolean}> | null;
  onOpenDocument: (path: string) => unknown | Promise<unknown>;
  onSelectFolder: (path: string) => void;
  onNewDocument: (parentPath?: string, extension?: DocumentExtension) => void;
  onNewDirectory: (parentPath?: string) => void;
  onDeleteDocument: (path: string) => void;
  onRename: (path: string) => void;
  onReload: () => void;
};

function creationItems(contextPath: string, disabled: boolean,
  onNewDocument: ProjectTreeProps["onNewDocument"], onNewDirectory: ProjectTreeProps["onNewDirectory"],
  parentPath = contextPath, newDocumentShortcut?: string): MenuEntry<string>[] {
  const formats: readonly [DocumentExtension, string][] = [["txt", "TXT"], ["md", "Markdown"], ["lode", "富文本"]];
  return [
    {id: "new-document", label: "新建文档", shortcut: newDocumentShortcut, icon: <Icon name="plus" />, disabled, restoreFocus: false,
      onSelect: path => { if (!disabled && path === contextPath) onNewDocument(parentPath); }},
    ...formats.map(([extension, label]) => ({
      id: `new-document-${extension}`, label: `新建 ${label} 文档`, icon: <Icon name="file" />, disabled, restoreFocus: false,
      onSelect: (path: string) => { if (!disabled && path === contextPath) onNewDocument(parentPath, extension); },
    })),
    {id: "new-directory", label: "新建文件夹", icon: <Icon name="folder" />, disabled, restoreFocus: false,
      onSelect: path => { if (!disabled && path === contextPath) onNewDirectory(parentPath); }},
  ];
}

function TreeNode({
  node, depth, renameShortcut, newDocumentShortcut, activeDocumentPath, selectedPath, openingPath, expanded, onSelectEntry, onToggleFolder, onOpenDocument, onNewDocument, onNewDirectory, onDeleteDocument, newDisabled, loading, deletingPath,
  onRename,
}: {
  node: ProjectTreeEntry;
  depth: number;
  renameShortcut?: string;
  newDocumentShortcut?: string;
  activeDocumentPath: string | null;
  selectedPath: string | null;
  openingPath: string | null;
  expanded: Set<string>;
  onSelectEntry: (path: string) => void;
  onToggleFolder: (path: string) => void;
  onOpenDocument: ProjectTreeProps["onOpenDocument"];
  onNewDocument: ProjectTreeProps["onNewDocument"];
  onNewDirectory: ProjectTreeProps["onNewDirectory"];
  onDeleteDocument: ProjectTreeProps["onDeleteDocument"];
  newDisabled: boolean;
  loading: boolean;
  deletingPath: string | null;
  onRename: ProjectTreeProps["onRename"];
}) {
  const indentation = { "--cmp-tree-depth": depth } as CSSProperties;

  if (node.children) {
    return (
      <li>
        <ContextMenuRegion context={node.path} label={`${node.name}目录操作`} items={[
          ...creationItems(node.path, newDisabled, onNewDocument, onNewDirectory, node.path, newDocumentShortcut),
          {type: "separator", id: "folder-actions-separator"},
          {id: "rename-folder", label: "重命名文件夹", shortcut: renameShortcut, visible: path => !!path, disabled: newDisabled || loading,
            restoreFocus: false, onSelect: path => { if (!newDisabled && !loading && node.path === path) onRename(path); }},
          { id: "toggle", label: expanded.has(node.path) ? "折叠" : "展开", disabled: loading,
            onSelect: (path) => { if (!loading && node.path === path) onToggleFolder(path); } },
        ]}>
          <button type="button" className="file-tree-entry file-tree-folder-toggle" style={indentation} title={node.name}
            data-project-tree-path={node.path}
            data-selected={selectedPath === node.path ? "true" : undefined}
            disabled={loading}
            onFocus={() => onSelectEntry(node.path)}
            aria-expanded={expanded.has(node.path)} onClick={event => {
              event.currentTarget.focus({preventScroll: true});
              onSelectEntry(node.path);
              onToggleFolder(node.path);
            }}>
            <Icon name={expanded.has(node.path) ? "chevronDown" : "chevronRight"} size="small" />
            <Icon name="folder" />
            <span className="file-tree-label">{node.name}</span>
          </button>
        </ContextMenuRegion>
        {expanded.has(node.path) && <ul>
          {node.children.length > 0 ? node.children.map((child) => (
            <TreeNode
              key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggleFolder={onToggleFolder}
              renameShortcut={renameShortcut}
              newDocumentShortcut={newDocumentShortcut}
              activeDocumentPath={activeDocumentPath} selectedPath={selectedPath} openingPath={openingPath}
              onSelectEntry={onSelectEntry} onOpenDocument={onOpenDocument}
              onNewDocument={onNewDocument} onNewDirectory={onNewDirectory} onDeleteDocument={onDeleteDocument}
              onRename={onRename} newDisabled={newDisabled} loading={loading} deletingPath={deletingPath}
            />
          )) : <li className="file-tree-empty" style={{ "--cmp-tree-depth": depth + 1 } as CSSProperties}>暂无文档</li>}
        </ul>}
      </li>
    );
  }

  const current = node.path === activeDocumentPath;
  const selected = node.path === selectedPath;
  const deleting = node.path === deletingPath;
  const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
  return (
    <li>
      <ContextMenuRegion context={node.path} label={`${node.name}文档操作`} items={[
        { id: "open", label: "打开文档", icon: <Icon name="file" />, disabled: loading || deleting || openingPath === node.path, restoreFocus: false,
          onSelect: (path) => { if (!loading && !deleting && openingPath !== path && node.path === path) return onOpenDocument(path); } },
        ...creationItems(node.path, newDisabled || deleting || loading, onNewDocument, onNewDirectory, parentPath, newDocumentShortcut),
        {id: "rename-file", label: "重命名文件", shortcut: renameShortcut, disabled: newDisabled || deleting || loading,
          restoreFocus: false, onSelect: path => { if (!newDisabled && !deleting && !loading && node.path === path) onRename(path); }},
        {type: "separator", id: "file-actions-separator"},
        {id: "delete-document", label: "删除文档", disabled: newDisabled || deleting || loading || openingPath === node.path, restoreFocus: false,
          onSelect: path => { if (!newDisabled && !loading && !deleting && openingPath !== path && node.path === path) onDeleteDocument(path); }},
      ]}>
        <button
          className="file-tree-entry file-tree-document"
          data-project-tree-path={node.path}
          data-selected={selected ? "true" : undefined}
          style={indentation}
          type="button"
          disabled={loading || deleting}
          aria-current={current ? "page" : undefined}
          aria-busy={openingPath === node.path || deleting}
          title={node.name}
          onFocus={() => onSelectEntry(node.path)}
          onClick={event => {
            if (loading || deleting) return;
            event.currentTarget.focus({preventScroll: true});
            onSelectEntry(node.path);
            if (event.detail === 0 || event.detail === 2) void onOpenDocument(node.path);
          }}
        >
          <span className="file-tree-spacer" />
          <Icon name="file" />
          <span className="file-tree-label">{node.name}</span>
        </button>
      </ContextMenuRegion>
    </li>
  );
}

export function ProjectTree({ shortcuts, projectName, entries, activeDocumentPath, openingPath, loading, error, active, newDisabled, deletingPath,
  lastRename, onOpenDocument, onSelectFolder, onNewDocument, onNewDirectory, onDeleteDocument, onRename, onReload }: ProjectTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set([""]));
  const [selectedPath, setSelectedPath] = useState<string | null>(activeDocumentPath);
  const tree = useRef<HTMLElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const canInteract = active && !loading;
  useSyncExternalStore(shortcuts.subscribe, shortcuts.getSnapshot, shortcuts.getSnapshot);
  const renameShortcut = shortcuts.getShortcut(shortcutCommandIds.renameEntry);
  const newDocumentShortcut = shortcuts.getShortcut(shortcutCommandIds.newDocument);

  useEffect(() => shortcuts.registerScope({
    id: shortcutScopeIds.projectTree,
    parentId: shortcutScopeIds.workbench,
    active: () => activeRef.current,
    contains(target) {
      const node = target instanceof Node ? target : null;
      return !!node && !!tree.current?.contains(node);
    },
  }), [shortcuts]);

  useEffect(() => {
    if (!tree.current?.contains(document.activeElement)) setSelectedPath(activeDocumentPath);
    if (!activeDocumentPath) return;
    const parts = activeDocumentPath.split("/");
    const parents = ["", ...parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"))];
    setExpanded((previous) => new Set([...previous, ...parents]));
  }, [activeDocumentPath]);

  useEffect(() => {
    if (!lastRename) return;
    const renamedPath = (path: string) => path === lastRename.fromPath || path.startsWith(`${lastRename.fromPath}/`)
      ? `${lastRename.toPath}${path.slice(lastRename.fromPath.length)}` : path;
    setSelectedPath(previous => previous === null ? null : renamedPath(previous));
    if (lastRename.directory) setExpanded(previous => new Set([...previous].map(renamedPath)));
  }, [lastRename]);

  function toggleFolder(path: string) {
    if (!canInteract) return;
    onSelectFolder(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function newDirectory(path = "") {
    if (!canInteract || newDisabled) return;
    setExpanded(previous => new Set([...previous, path]));
    onNewDirectory(path);
  }

  return (
    <aside
      className="project-management-panel"
      id="project-management-tree"
      aria-label="项目文件"
    >
      <div className="project-management-panel-header">
        <div className="project-management-panel-actions">
          <IconButton id="project-management-new-document" label="新建文档"
            tooltip={newDocumentShortcut ? `新建文档 · ${newDocumentShortcut}` : undefined}
            disabled={!canInteract || newDisabled} onClick={() => onNewDocument()}><Icon name="plus" /></IconButton>
          <IconButton label="更多项目操作" disabled><Icon name="more" /></IconButton>
        </div>
      </div>
      <ContextMenuRegion context="" label="文件目录树操作" disabled={!active}
        items={creationItems("", newDisabled || !canInteract, onNewDocument, newDirectory, "", newDocumentShortcut)}>
        <nav ref={tree} className="file-tree-scroll" aria-label="文件目录树" aria-busy={loading} tabIndex={0}
          data-shortcut-scope={shortcutScopeIds.projectTree}>
          {loading && <p className="file-tree-message" role="status">正在读取文档…</p>}
          {error && <div className="file-tree-message" role="alert">
            <p className="project-error">{error}</p>
            <Button variant="ghost" disabled={!active} onClick={onReload}>重新加载</Button>
          </div>}
          {(!loading && !error || entries.length > 0) && <ul className="file-tree">
            <TreeNode
              node={{ path: "", name: projectName, children: entries }}
              depth={0} expanded={expanded} onToggleFolder={toggleFolder}
              renameShortcut={renameShortcut}
              newDocumentShortcut={newDocumentShortcut}
              activeDocumentPath={activeDocumentPath} selectedPath={selectedPath} openingPath={openingPath}
              onSelectEntry={setSelectedPath}
              onOpenDocument={path => { if (canInteract) return onOpenDocument(path); }}
              onNewDocument={(path, extension) => { if (canInteract && !newDisabled) onNewDocument(path, extension); }}
              onNewDirectory={newDirectory} onDeleteDocument={onDeleteDocument} onRename={onRename}
              newDisabled={newDisabled || !canInteract} loading={!canInteract} deletingPath={deletingPath}
            />
          </ul>}
        </nav>
      </ContextMenuRegion>
    </aside>
  );
}
