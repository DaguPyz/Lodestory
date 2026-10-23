import type {ReactElement, ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";

type Condition<T> = boolean | ((context: T) => boolean);
type EntryBase<T> = {
    id: string;
    visible?: Condition<T>;
};

export type MenuAction<T = undefined> = EntryBase<T> & {
    type?: "action";
    label: string;
    icon?: ReactNode;
    shortcut?: string;
    disabled?: Condition<T>;
    onSelect: (context: T) => unknown | Promise<unknown>;
    /** Set false when the action moves focus, navigates, or opens a dialog. */
    restoreFocus?: boolean;
};

export type MenuEntry<T = undefined> = MenuAction<T>
    | (EntryBase<T> & { type: "separator" })
    | (EntryBase<T> & { type: "group"; label?: string; items: readonly MenuEntry<T>[] })
    | (EntryBase<T> & {
    type: "submenu";
    label: string;
    icon?: ReactNode;
    disabled?: Condition<T>;
    items: readonly MenuEntry<T>[]
});

export type MenuConfig<T = undefined> = readonly MenuEntry<T>[] | ((context: T) => readonly MenuEntry<T>[]);

/** Props accepted by the runtime menu-region component provided by context-menu. */
export type ContextMenuRegionProps<T = undefined> = {
    /** The element must forward DOM props and its ref. */
    children: ReactElement;
    items?: MenuConfig<T>;
    context?: T;
    mode?: "custom" | "native";
    disabled?: boolean;
    label?: string;
    density?: "comfortable" | "spacious" | "compact";
    onActionError?: (error: unknown) => void;
    fallbackFocus?: () => HTMLElement | null;
};

/**
 * Runtime menu-region component supplied by the context-menu plugin.
 * Consumers should render it only inside the UI root wrapper registered by the same
 * plugin. Disabling or unmounting a region closes its open menu.
 */
export type ContextMenuService = {
    readonly Region: <T = undefined>(props: ContextMenuRegionProps<T>) => ReactElement;
};

/** Shared capability key; consumers must declare it in requires. */
export const contextMenuKey = createServiceKey<ContextMenuService>("app/context-menu");
