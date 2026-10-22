import { Menu } from "@base-ui/react/menu";
import { Icon, IconButton } from "@lodestory/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useContextMenus, type MenuAction } from "../context-menu";
import type { MenuCloseReason } from "../context-menu/menuCoordinator";

/** The welcome plugin owns its actions; the coordinator only arbitrates open surfaces. */
export function ProjectActionsMenu({ projectId, name, disabled, actions }: {
  projectId: string;
  name: string;
  disabled: boolean;
  actions: MenuAction<string>[];
}) {
  const menus = useContextMenus();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const [open, setOpen] = useState(false);
  const [immediateClose, setImmediateClose] = useState(false);
  const [density, setDensity] = useState("spacious");

  function close(reason: MenuCloseReason) {
    restoreFocus.current = reason === "dismiss";
    setImmediateClose(reason !== "dismiss");
    setOpen(false);
    if (reason !== "dismiss") menus.release(id);
  }

  useEffect(() => {
    if (disabled) close("lifecycle");
  }, [disabled]);
  useEffect(() => () => menus.release(id), [menus, id]);

  return <Menu.Root modal={false} open={open && !disabled}
    onOpenChangeComplete={(next) => { if (!next) menus.release(id); }}
    onOpenChange={(next, details) => {
      if (next) {
        if (disabled) { details.cancel(); return; }
        restoreFocus.current = true;
        setImmediateClose(false);
        setDensity(trigger.current?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity ?? "comfortable");
        menus.activate(id, close);
      }
      setOpen(next);
    }}>
    <Menu.Trigger ref={trigger} disabled={disabled} render={<IconButton label={`${name}的更多操作`} />}>
      <Icon name="more" />
    </Menu.Trigger>
    <Menu.Portal data-ui-density={density}>
      <Menu.Positioner className="project-menu-positioner" sideOffset={4} collisionPadding={8} align="end">
        <Menu.Popup className="project-menu" data-immediate-close={immediateClose || undefined}
          finalFocus={() => restoreFocus.current ? trigger.current : false}>
          {actions.filter((action) => action.id !== "open").map((action) => <Menu.Item
            key={action.id} className="project-menu-item" disabled={action.disabled as boolean}
            onClick={() => { close("action"); void action.onSelect(projectId); }}>{action.label}</Menu.Item>)}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
