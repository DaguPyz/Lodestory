import {useEffect, type ReactNode} from "react";
import type {Plugin} from "@lodestory/sdk";
import {configKey, type ConfigItem} from "@lodestory/sdk/config";
import {shortcutsKey, shortcutScopeIds} from "@lodestory/sdk/shortcuts";
import {uiInteractionKey, uiKey} from "@lodestory/sdk/ui";
import type {ConfigValue} from "@lodestory/sdk/config";
import {createShortcutsStore} from "./shortcutsStore";
import {normalizeShortcut} from "./shortcutsStore";

type Overrides = Readonly<Record<string, string | null>>;

export const shortcutOverridesConfig: ConfigItem<Overrides> = Object.freeze({
  id: "shortcuts.bindings",
  defaultValue: Object.freeze({}),
  effect: "live",
  validate(value: unknown): value is Overrides {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && (Object.getPrototypeOf(prototype) !== null || prototype.constructor?.name !== "Object")) return false;
    return Object.entries(value).every(([id, keys]) => {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id) || keys !== null && typeof keys !== "string") return false;
      if (typeof keys === "string") { try { normalizeShortcut(keys); } catch { return false; } }
      return true;
    });
  },
});

function ShortcutListener({children, hasActiveOverlay, handleKeyDown}: {
  children: ReactNode;
  hasActiveOverlay(): boolean;
  handleKeyDown(event: KeyboardEvent, context: {blocked: boolean; editable: boolean; target: EventTarget | null}): boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.hidden || !document.hasFocus() || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      const editable = !!target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
        || target instanceof HTMLElement && target.isContentEditable;
      handleKeyDown(event, {blocked: hasActiveOverlay(), editable, target});
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasActiveOverlay, handleKeyDown]);
  return <>{children}</>;
}

/** Application-scoped command and single-chord shortcut registry. */
export function createShortcutsPlugin(): Plugin {
  let dispose: (() => void) | undefined;
  return {
    id: "shortcuts", requires: [uiKey, uiInteractionKey, configKey], provides: [shortcutsKey],
    activate(context) {
      const ui = context.get(uiKey), config = context.get(configKey);
      const interaction = context.get(uiInteractionKey);
      let removeConfig: (() => void) | undefined;
      let removeConfigSubscription: (() => void) | undefined;
      let removeWrapper: (() => void) | undefined;
      let store: ReturnType<typeof createShortcutsStore> | undefined;
      try {
        removeConfig = config.register(shortcutOverridesConfig);
        const configSnapshot = () => config.getSnapshot(shortcutOverridesConfig);
        store = createShortcutsStore({
          getOverrides: configSnapshot,
          async persist(bindingId, keys) {
            const next = {...configSnapshot()};
            if (keys === undefined) delete next[bindingId];
            else next[bindingId] = keys;
            await config.set(shortcutOverridesConfig, next as Record<string, ConfigValue>);
          },
        });
        const shortcuts = store.service;
        const removeApplicationScope = shortcuts.registerScope({id: shortcutScopeIds.application, active: () => true});
        removeConfigSubscription = config.subscribe(shortcutOverridesConfig, store.refresh);
        context.provide(shortcutsKey, shortcuts);
        removeWrapper = ui.addWrapper({id: "shortcuts.key-listener", order: 5,
          wrap: children => <ShortcutListener hasActiveOverlay={interaction.hasActiveOverlay} handleKeyDown={store!.handleKeyDown}>{children}</ShortcutListener>});
        dispose = () => {
          const errors: unknown[] = [];
          for (const remove of [removeWrapper, removeConfigSubscription, removeApplicationScope]) {
            try { remove?.(); } catch (error) { errors.push(error); }
          }
          try { store?.dispose(); } catch (error) { errors.push(error); }
          try { removeConfig?.(); } catch (error) { errors.push(error); }
          if (errors.length) throw Object.assign(new Error("Shortcuts failed to stop."), {errors});
        };
      } catch (error) {
        removeWrapper?.(); removeConfigSubscription?.(); store?.dispose(); removeConfig?.();
        throw error;
      }
    },
    deactivate() { const stop = dispose; dispose = undefined; stop?.(); },
  };
}
