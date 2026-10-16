import type {Plugin} from "@lodestory/sdk";
import {layoutKey, type LayoutService} from "@lodestory/sdk/layout";
import {uiKey} from "@lodestory/sdk/ui";
import {themeKey} from "@lodestory/sdk/theme";
import {errorUiKey} from "@lodestory/sdk/error";
import {DefaultLayout} from "./DefaultLayout";
import {createLayoutStore} from "./layoutStore";

/** 默认工作台布局；其他实现只需提供相同的 layoutKey，无需修改内容插件。 */
export function createDefaultLayoutPlugin(): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    id: "default-layout",
    requires: [uiKey, themeKey, errorUiKey],
    provides: [layoutKey],
    activate(context) {
      const ui = context.get(uiKey);
      const {ErrorBoundary} = context.get(errorUiKey);
      let removeWrapper: (() => void) | undefined;
      const store = createLayoutStore(() => removeWrapper?.());
      cleanup = () => { try { removeWrapper?.(); } finally { store.dispose(); } };
      if (typeof window !== "undefined") store.setViewport(window.innerWidth, 16);
      const service: LayoutService = {
        View: ({active}) => <DefaultLayout store={store} active={active} ErrorBoundary={ErrorBoundary}/>,
        registerContent: store.registerContent,
        show: store.show,
        hide: store.hide,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
      };
      context.provide(layoutKey, Object.freeze(service));
      removeWrapper = ui.addWrapper({id: "default-layout", order: 30, prepare: store.start, wrap: children => children});
    },
    deactivate() {
      const stop = cleanup;
      cleanup = undefined;
      stop?.();
    },
  };
}
