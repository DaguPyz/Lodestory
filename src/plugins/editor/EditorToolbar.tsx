import { useEffect, useRef } from "react";
import { Button, IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useContextMenus } from "../context-menu";

type EditorToolbarProps = {
  active: boolean;
  projectName: string;
  focusMode: boolean;
  referenceVisible: boolean;
  treeVisible: boolean;
  onToggleTree: () => void;
  onToggleFocus: () => void;
  onToggleReference: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
};

export function EditorToolbar({
  active, projectName, focusMode, referenceVisible, treeVisible, onToggleTree, onToggleFocus, onToggleReference, onBack, onOpenSettings,
}: EditorToolbarProps) {
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const menus = useContextMenus();

  useEffect(() => () => menus.release("editor-project-menu"), [menus]);

  useEffect(() => {
    if (!active) {
      if (projectMenu.current) projectMenu.current.open = false;
      return;
    }
    function closeOutside(event: PointerEvent) {
      if (projectMenu.current?.open && event.target instanceof Node && !projectMenu.current.contains(event.target)) {
        projectMenu.current.open = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.isComposing && projectMenu.current?.open) {
        event.stopPropagation();
        projectMenu.current.open = false;
        projectMenu.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [active]);

  function leaveProject() {
    if (projectMenu.current) projectMenu.current.open = false;
    onBack();
  }

  function openSettings() {
    if (projectMenu.current) projectMenu.current.open = false;
    onOpenSettings();
  }

  return (
    <header className="editor-toolbar">
      <div className="editor-brand" aria-label="Lodestory">
        <Icon name="book" size="large" />
        <span>Lodestory</span>
      </div>

      <details className="editor-project-menu" ref={projectMenu} onToggle={() => {
        if (projectMenu.current?.open) menus.activate("editor-project-menu", () => {
          if (projectMenu.current) projectMenu.current.open = false;
        });
        else menus.release("editor-project-menu");
      }}>
        <summary className="editor-project-trigger" title={projectName}>
          <span>{projectName}</span>
          <Icon name="chevronDown" size="small" />
        </summary>
        <div className="editor-project-popover">
          <Button variant="ghost" onClick={leaveProject}><Icon name="arrowLeft" />返回欢迎页</Button>
          <Button variant="ghost" onClick={openSettings}><Icon name="settings" />外观设置</Button>
        </div>
      </details>

      <div className="editor-toolbar-actions">
        <button
          type="button" className="icon-button editor-mobile-tree-toggle"
          aria-label="项目文件" title="项目文件" aria-controls="editor-project-tree"
          aria-pressed={treeVisible} disabled={focusMode} onClick={onToggleTree}
        ><Icon name="file" /></button>
        <IconButton label="搜索项目" disabled><Icon name="search" /></IconButton>
        <IconButton
          id="editor-reference-toggle"
          label={referenceVisible ? "收起参考资料" : "显示参考资料"}
          aria-controls="editor-reference"
          aria-pressed={referenceVisible}
          onClick={onToggleReference}
          disabled={focusMode}
        >
          <Icon name="split" />
        </IconButton>
        <Button variant="ghost" id="editor-focus-toggle" aria-pressed={focusMode}
          aria-label={focusMode ? "退出专注模式" : "专注模式"}
          title={focusMode ? "退出专注模式" : "专注模式"}
          onClick={onToggleFocus}>
          <Icon name="focus" />
          <span>{focusMode ? "退出专注" : "专注模式"}</span>
        </Button>
        <IconButton label="更多工作空间操作" disabled><Icon name="more" /></IconButton>
      </div>
    </header>
  );
}
