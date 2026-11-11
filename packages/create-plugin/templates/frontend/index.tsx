import {lazy, Suspense} from "react";
import type {Plugin} from "@lodestory/sdk";
import {layoutKey} from "@lodestory/sdk/layout";

const Panel = lazy(() => import("./Panel"));

/** The build tool substitutes the ID and name from plugin.json. */
export default function createPlugin(): Plugin {
  const id = __LODESTORY_PLUGIN_ID__;
  let removeContent: (() => void) | undefined;
  return {
    id,
    requires: [layoutKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      removeContent = context.track(layout.registerContent({
        id: id + ".main",
        title: __LODESTORY_PLUGIN_NAME__,
        role: "main",
        render: ({active}) => <Suspense fallback={<span>加载中…</span>}><Panel active={active}/></Suspense>,
      }));
    },
    deactivate() {
      const remove = removeContent;
      removeContent = undefined;
      remove?.();
    },
  };
}
