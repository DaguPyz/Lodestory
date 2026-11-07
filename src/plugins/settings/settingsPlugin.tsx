import type {Plugin} from "@lodestory/sdk";
import {Icon} from "@lodestory/ui";
import {navigationLayoutKey} from "@lodestory/sdk/navigation-layout";
import {settingsKey} from "@lodestory/sdk/settings";
import {themeKey} from "@lodestory/sdk/theme";
import {uiKey} from "@lodestory/sdk/ui";
import {configKey} from "@lodestory/sdk/config";
import {errorUiKey} from "@lodestory/sdk/error";
import {ThemeSettings} from "./ThemeSettings";
import {MotionSettings} from "./MotionSettings";
import {SettingsDialog} from "./SettingsDialog";
import {createMotionSettingsModel} from "./motionSettingsModel";
import {createSettingsStore} from "./settingsStore";

/** Application-scoped settings shell; contributors own their views and data. */
export function createSettingsPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    id: "settings",
    requires: [uiKey, navigationLayoutKey, themeKey, errorUiKey, configKey],
    provides: [settingsKey],
    activate(context) {
      const ui = context.get(uiKey);
      const navigation = context.get(navigationLayoutKey);
      const theme = context.get(themeKey);
      const config = context.get(configKey);
      const {ErrorBoundary} = context.get(errorUiKey);
      const store = createSettingsStore();
      const motion = createMotionSettingsModel(config);
      const removeSections: (() => void)[] = [];
      let removeWrapper: (() => void) | undefined;
      let removeAction: (() => void) | undefined;
      cleanup = async () => {
        const errors: unknown[] = [];
        for (const remove of [removeWrapper, removeAction, ...removeSections.reverse()]) {
          try { remove?.(); } catch (error) { errors.push(error); }
        }
        try { store.dispose(); } catch (error) { errors.push(error); }
        try { await motion.dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new Error("Settings failed to stop."), {errors});
      };
      removeSections.push(store.service.registerSection({
        id: "appearance.theme", group: "外观", title: "主题", order: 10,
        render: () => <ThemeSettings service={theme}/>,
      }));
      removeSections.push(store.service.registerSection({
        id: "appearance.motion", group: "外观", title: "动效", order: 20,
        render: () => <MotionSettings config={config} model={motion}/>,
      }));
      context.provide(settingsKey, store.service);
      removeWrapper = context.track(ui.addWrapper({
        id: "settings.dialog", order: 30,
        prepare: store.start,
        wrap: children => <SettingsDialog store={store} ErrorBoundary={ErrorBoundary}>{children}</SettingsDialog>,
      }));
      removeAction = context.track(navigation.registerAction({
        id: "settings",
        navigation: {label: "设置", icon: <Icon name="settings"/>, group: "secondary", order: 0},
        run: () => { if (!store.service.open()) throw new Error("Settings are unavailable."); },
      }));
    },
    async deactivate() { const stop = cleanup; cleanup = undefined; await stop?.(); },
  };
}
