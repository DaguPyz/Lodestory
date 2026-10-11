import type { ReactNode } from "react";
import type { PluginContext } from "../../src/plugin-core/Plugin";
import { uiKey } from "../../src/ui";

export function registerUi(context: PluginContext, root: ReactNode): void {
  const ui = context.get(uiKey);
  ui.setRoot(() => root);
  ui.addWrapper({
    id: "fixture-wrapper",
    order: 10,
    wrap: (children) => children,
  });
}
