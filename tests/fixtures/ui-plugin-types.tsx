import type { ReactNode } from "react";
import type { PluginContext } from "@lodestory/sdk";
import { configKey } from "@lodestory/sdk/config";
import { errorUiKey } from "@lodestory/sdk/error";
import { uiInitialPageConfig, uiKey, type UiNavigationRequest } from "@lodestory/sdk/ui";

export function registerUi(context: PluginContext, root: ReactNode): void {
  const ui = context.get(uiKey);
  const config = context.get(configKey);
  const initialPage: string | null = config.getSnapshot(uiInitialPageConfig);
  const updateInitialPage: Promise<void> = config.set(uiInitialPageConfig, initialPage);
  void updateInitialPage;
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
  const removeGuard = ui.registerNavigationGuard({
    id: "fixture-guard",
    prepare(request: UiNavigationRequest) {
      const destination: string = request.to.id;
      void destination;
      return { commit() {}, cancel() {}, async complete() {} };
    },
  });
  const navigation: Promise<boolean> = ui.openPage("fixture-page", { source: "fixture" });
  void navigation;
  const snapshot = ui.getSnapshot();
  const currentPageId: string | undefined = snapshot.current?.id;
  void currentPageId;
  const unsubscribe = ui.subscribe(() => {});
  const back: Promise<boolean> = ui.back();
  void back;
  void removeGuard;
  unsubscribe();
}
