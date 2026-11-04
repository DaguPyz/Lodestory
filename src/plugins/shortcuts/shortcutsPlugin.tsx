import {useEffect, type ReactNode} from "react";
import type {Plugin} from "@lodestory/sdk";
import {configKey, type ConfigItem} from "@lodestory/sdk/config";
import {shortcutsKey, shortcutScopeIds} from "@lodestory/sdk/shortcuts";
import {settingsKey} from "@lodestory/sdk/settings";
import {uiInteractionKey, uiKey} from "@lodestory/sdk/ui";
import type {ConfigValue} from "@lodestory/sdk/config";
import {createShortcutsStore, normalizeShortcut} from "./shortcutsStore";
import {createShortcutSettingsModel} from "./shortcutSettingsModel";
import {ShortcutSettings} from "./ShortcutSettings";

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
  let dispose: (() => Promise<void>) | undefined;
  return {
    id: "shortcuts", requires: [uiKey, uiInteractionKey, configKey, settingsKey], provides: [shortcutsKey],
    async activate(context) {
      const ui = context.get(uiKey), config = context.get(configKey);
      const interaction = context.get(uiInteractionKey);
      const settings = context.get(settingsKey);
      let removeConfig: (() => void) | undefined;
      let removeConfigSubscription: (() => void) | undefined;
      let removeWrapper: (() => void) | undefined;
      let removeSettingsSection: (() => void) | undefined;
      let removeApplicationScope: (() => void) | undefined;
      let store: ReturnType<typeof createShortcutsStore> | undefined;
      let settingsModel: ReturnType<typeof createShortcutSettingsModel> | undefined;
      const stop = async () => {
        const errors: unknown[] = [];
        for (const remove of [removeWrapper, removeSettingsSection]) {
          try { remove?.(); } catch (error) { errors.push(error); }
        }
        try { await settingsModel?.dispose(); } catch (error) { errors.push(error); }
        try { await store?.dispose(); } catch (error) { errors.push(error); }
        for (const remove of [removeConfigSubscription, removeApplicationScope, removeConfig]) {
          try { remove?.(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw Object.assign(new Error("Shortcuts failed to stop."), {errors});
      };
      dispose = stop;
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
        removeApplicationScope = shortcuts.registerScope({id: shortcutScopeIds.application, active: () => true});
        removeConfigSubscription = config.subscribe(shortcutOverridesConfig, store.refresh);
        context.provide(shortcutsKey, shortcuts);
        settingsModel = createShortcutSettingsModel(shortcuts);
        const model = settingsModel;
        removeSettingsSection = settings.registerSection({
          id: "shortcuts.keymap", group: "操作", title: "快捷键", order: 30,
          render: () => <ShortcutSettings shortcuts={shortcuts} model={model}/>,
        });
        removeWrapper = ui.addWrapper({id: "shortcuts.key-listener", order: 5,
          wrap: children => <ShortcutListener hasActiveOverlay={interaction.hasActiveOverlay} handleKeyDown={store!.handleKeyDown}>{children}</ShortcutListener>});
      } catch (error) {
        dispose = undefined;
        try { await stop(); } catch (cleanupError) {
          throw Object.assign(new Error("Shortcuts failed to activate and clean up."), {
            name: "ShortcutActivationError", activationError: error, cleanupError,
          });
        }
        throw error;
      }
    },
    async deactivate() { const stop = dispose; dispose = undefined; await stop?.(); },
  };
}
