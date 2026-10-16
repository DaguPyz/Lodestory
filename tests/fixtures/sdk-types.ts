import {
  createEventKey,
  createServiceKey,
  type EventKey,
  type EventListener,
  type Plugin,
  type PluginContext,
  type ServiceKey,
} from "@lodestory/sdk";
import {layoutKey, type LayoutService, type LayoutContent} from "@lodestory/sdk/layout";
import { uiKey, type UiService } from "@lodestory/sdk/ui";
import { errorUiKey, type ErrorUiService } from "@lodestory/sdk/error";
import { themeKey, type ThemeConfig, type ThemeService } from "@lodestory/sdk/theme";

type Document = { read(): string };
type DocumentChanged = { documentId: string; revision: number };

const documentKey: ServiceKey<Document> = createServiceKey<Document>("example/document");
const documentChanged: EventKey<DocumentChanged> = createEventKey<DocumentChanged>("example/document-changed");
const listener: EventListener<DocumentChanged> = ({ documentId, revision }) => {
  const id: string = documentId;
  const currentRevision: number = revision;
  void id;
  void currentRevision;
};

declare const context: PluginContext;
const plugin: Plugin = {
  id: "sdk-types",
  requires: [documentKey, uiKey, errorUiKey, themeKey, layoutKey],
  provides: [],
  activate(pluginContext) {
    const document = pluginContext.get(documentKey);
    const text: string = document.read();
    const ui: UiService = pluginContext.get(uiKey);
    const errorUi: ErrorUiService = pluginContext.get(errorUiKey);
    const theme: ThemeService = pluginContext.get(themeKey);
    const unsubscribe = pluginContext.on(documentChanged, listener);
    const emitted: Promise<void> = pluginContext.emit(documentChanged, { documentId: text, revision: 1 });
    const layout: LayoutService = pluginContext.get(layoutKey);
    const content: LayoutContent = {id: "example.navigation", title: "导航", role: "navigation", render: ({active}) => String(active)};
    const removeContent: () => void = layout.registerContent(content);
    layout.show(content.id);
    layout.hide(content.id);
    const shown: readonly string[] = layout.getSnapshot().shownIds;
    // @ts-expect-error Layout roles describe usage, not positions.
    layout.registerContent({...content, role: "left"});
    // @ts-expect-error A snapshot cannot be mutated by a consumer.
    layout.getSnapshot().shownIds.push("another");
    removeContent();
    void shown;
    void layout.View;
    void ui;
    void errorUi.ErrorBoundary;
    void errorUi.ErrorView;
    const removeTheme: () => void = theme.registerTheme({
      schemaVersion: 1, id: "example.test.ink", name: "Ink", type: "dark",
      colors: { "surface.content": "#171A23" },
    });
    theme.setPreference({ mode: "fixed", themeId: "example.test.ink" });
    theme.setPreference({ mode: "system", lightThemeId: "example.test.paper", darkThemeId: "example.test.ink" });
    const color: string = theme.getSnapshot().theme?.colors["surface.content"] ?? "";
    const fallbackId: string = theme.getSnapshot().fallbackThemeIds.light;
    void fallbackId;
    void color;
    // @ts-expect-error Only standard color names are accepted.
    theme.registerTheme({ schemaVersion: 1, id: "example.test.invalid", name: "Invalid", type: "dark", colors: { "editor.background": "#FFFFFF" } });
    // @ts-expect-error A theme's type is an attribute, not its selection identity.
    theme.setPreference("dark");
    removeTheme();
    void emitted;
    unsubscribe();
    // @ts-expect-error The event payload must match its public generic contract.
    void pluginContext.emit(documentChanged, { documentId: text, revision: "one" });
    // @ts-expect-error The listener payload is inferred from EventKey<T>.
    pluginContext.on(documentChanged, (payload: number) => void payload);
  },
};

// @ts-expect-error ServiceKey<T> preserves the capability interface.
const wrongDocument: number = context.get(documentKey);
void plugin;
void wrongDocument;

const themeConfig: ThemeConfig = {
  defaultThemeId: "example.ink.dark",
  fallbackThemeIds: { dark: "example.ink.dark", light: "example.paper.light" },
};
void themeConfig;
