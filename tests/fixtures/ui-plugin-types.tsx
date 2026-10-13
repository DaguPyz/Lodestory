import type { ReactNode } from "react";
import type { PluginContext } from "@lodestory/sdk";
import { errorUiKey } from "@lodestory/sdk/error";
import { uiKey } from "@lodestory/sdk/ui";

export function registerUi(context: PluginContext, root: ReactNode): void {
  const ui = context.get(uiKey);
  const { ErrorBoundary } = context.get(errorUiKey);
  ui.registerPage({
    id: "fixture-page",
    render: ({ params, active }) => {
      const pageParams: unknown = params;
      const pageIsActive: boolean = active;
      void pageParams;
      void pageIsActive;
      return <ErrorBoundary>{root}</ErrorBoundary>;
    },
  });
  ui.addWrapper({
    id: "fixture-wrapper",
    order: 10,
    wrap: (children) => children,
  });
  ui.openPage("fixture-page", { source: "fixture" });
  const snapshot = ui.getSnapshot();
  const currentPageId: string | undefined = snapshot.current?.id;
  void currentPageId;
  const unsubscribe = ui.subscribe(() => {});
  ui.back();
  unsubscribe();
}
