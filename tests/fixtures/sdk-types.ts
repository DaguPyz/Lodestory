import {
  createEventKey,
  createServiceKey,
  type EventKey,
  type EventListener,
  type Plugin,
  type PluginContext,
  type ServiceKey,
} from "@lodestory/sdk";
import { uiKey, type UiService } from "@lodestory/sdk/ui";
import { errorUiKey, type ErrorUiService } from "@lodestory/sdk/error";
import { themeKey, type ThemeService } from "@lodestory/sdk/theme";

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
  requires: [documentKey, uiKey, errorUiKey, themeKey],
  provides: [],
  activate(pluginContext) {
    const document = pluginContext.get(documentKey);
    const text: string = document.read();
    const ui: UiService = pluginContext.get(uiKey);
    const errorUi: ErrorUiService = pluginContext.get(errorUiKey);
    const theme: ThemeService = pluginContext.get(themeKey);
    const unsubscribe = pluginContext.on(documentChanged, listener);
    const emitted: Promise<void> = pluginContext.emit(documentChanged, { documentId: text, revision: 1 });
    void ui;
    void errorUi.ErrorBoundary;
    void errorUi.ErrorView;
    void theme;
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
