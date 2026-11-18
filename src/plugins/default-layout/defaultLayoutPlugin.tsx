import type {Plugin} from "@lodestory/sdk";
import {flushSync} from "react-dom";
import {layoutExternalCapability, layoutKey, type LayoutService} from "@lodestory/sdk/layout";
import {pluginPackagesKey} from "@lodestory/sdk/plugin-packages";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {errorUiKey} from "@lodestory/sdk/error";
import {configKey} from "@lodestory/sdk/config";
import {i18nKey} from "@lodestory/sdk/i18n";
import {DefaultLayout} from "./DefaultLayout";
import {createLayoutStore} from "./layoutStore";
import {createNavigationWidthModel} from "./navigationWidth";
import {layoutMessages} from "./i18n";

/** 默认工作台布局；其他实现只需提供相同的 layoutKey，无需修改内容插件。 */
export function createDefaultLayoutPlugin(): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    id: "default-layout",
    requires: [uiKey, themeKey, errorUiKey, configKey, pluginPackagesKey, i18nKey],
    provides: [layoutKey],
    activate(context) {
      const ui = context.get(uiKey);
      const {ErrorBoundary} = context.get(errorUiKey);
      const packages = context.get(pluginPackagesKey);
      const i18n = context.get(i18nKey);
      const widths = createNavigationWidthModel(context.get(configKey));
      let removeWrapper: (() => void) | undefined;
      let removeCapability: (() => void) | undefined;
      let removeMessages: (() => void) | undefined;
      const store = createLayoutStore(remove => flushSync(remove));
      cleanup = () => {
        try { removeWrapper?.(); }
        finally {
          try { store.dispose(); }
          finally {
            try { widths.dispose(); }
            finally { try { removeCapability?.(); } finally { removeMessages?.(); } }
          }
        }
      };
      removeMessages = i18n.registerMessages("default-layout", layoutMessages);
      if (typeof window !== "undefined") store.setViewport(window.innerWidth, 16);
      const service: LayoutService = {
        View: ({active}) => <DefaultLayout store={store} widths={widths} active={active} ErrorBoundary={ErrorBoundary} i18n={i18n}/>,
        registerContent: store.registerContent,
        registerContents: store.registerContents,
        show: store.show,
        hide: store.hide,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
      };
      context.provide(layoutKey, Object.freeze(service));
      removeCapability = packages.registerCapability(layoutExternalCapability);
      removeWrapper = context.track(ui.addWrapper({id: "default-layout", order: 30, prepare: store.start, wrap: children => children}));
    },
    deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      stop?.();
    },
  };
}
