import type {ComponentType} from "react";
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
import {navigationLayoutKey, type NavigationLayoutPage, type NavigationLayoutService} from "@lodestory/sdk/navigation-layout";
import { uiKey, type UiService } from "@lodestory/sdk/ui";
import type { UiNavigationRequest } from "@lodestory/sdk/ui";
import { errorUiKey, type ErrorUiService } from "@lodestory/sdk/error";
import { themeKey, type ThemeConfig, type ThemeService } from "@lodestory/sdk/theme";
import { workbenchKey, type LeaveReason, type WorkbenchProject, type WorkbenchService, type WorkbenchSession } from "@lodestory/sdk/workbench";
import { configKey, type ConfigItem, type ConfigService, type ConfigValue } from "@lodestory/sdk/config";
import {
  documentsKey,
  documentCreateRequested,
  documentRevealRequested,
  type DocumentCreateRequest,
  type DocumentRevealRequest,
  type DocumentSaveState,
  type DocumentSnapshot,
  type DocumentWorkspace,
  type DocumentsService,
  type OpenDocument,
} from "@lodestory/sdk/documents";
import {
  bodyEditorKey,
  type BodyEditorService,
  type EditorDefinition,
  type EditorFormat,
  type EditorHandle,
  type EditorProps,
} from "@lodestory/sdk/body-editor";

type Document = { read(): string };
type DocumentChanged = { documentId: string; revision: number };

const documentKey: ServiceKey<Document> = createServiceKey<Document>("example/document");
const documentChanged: EventKey<DocumentChanged> = createEventKey<DocumentChanged>("example/document-changed");
const bodyEditorService: BodyEditorService = {
  registerEditor(definition) {
    const editorId: string = definition.id;
    const formats: readonly EditorFormat[] = definition.formats;
    const load: Promise<{readonly default: ComponentType<EditorProps>}> = definition.load();
    void editorId;
    void formats;
    void load;
    return () => {};
  },
  getText(fileName, content) {
    void fileName;
    return content;
  },
  subscribe(listener) {
    void listener;
    return () => {};
  },
};
const welcomePage: ConfigItem<string | null> = {
  id: "ui.initialPage",
  defaultValue: null,
  effect: "restart",
  validate: (value): value is string | null => value === null || typeof value === "string",
};
const testConfig: ConfigItem<{ readonly enabled: boolean }> = {
  id: "example.enabled",
  defaultValue: { enabled: true },
  effect: "live",
  validate: (value): value is { readonly enabled: boolean } => typeof value === "object" && value !== null && "enabled" in value,
};
const listener: EventListener<DocumentChanged> = ({ documentId, revision }) => {
  const id: string = documentId;
  const currentRevision: number = revision;
  void id;
  void currentRevision;
};

declare const context: PluginContext;
const plugin: Plugin = {
  id: "sdk-types",
  requires: [documentKey, uiKey, errorUiKey, themeKey, layoutKey, navigationLayoutKey, workbenchKey, configKey, documentsKey, bodyEditorKey],
  provides: [],
  activate(pluginContext) {
    const document = pluginContext.get(documentKey);
    const text: string = document.read();
    const ui: UiService = pluginContext.get(uiKey);
    const config: ConfigService = pluginContext.get(configKey);
    const documents: DocumentsService = pluginContext.get(documentsKey);
    const bodyEditor: BodyEditorService = pluginContext.get(bodyEditorKey);
    const removeEditor: () => void = bodyEditor.registerEditor({
      id: "example.markdown",
      formats: ["markdown"],
      getText(content: string, format: EditorFormat): string {
        void format;
        return content;
      },
      async load() {
        const Editor: ComponentType<EditorProps> = (props: EditorProps) => {
          const content: string = props.content;
          const active: boolean = props.active;
          const readOnly: boolean = props.readOnly;
          props.onChange(content);
          const handle: EditorHandle = {focus() {}};
          props.onReady(handle);
          props.onError(new Error("editor example"));
          const saveAs: Promise<void> | undefined = props.onSaveAs?.({extension: ".lode", content});
          void active;
          void readOnly;
          void saveAs;
          return null;
        };
        return {default: Editor};
      },
    });
    const workspace: DocumentWorkspace | null = documents.getWorkspace("session-1");
    if (workspace) {
      const snapshot: DocumentSnapshot = workspace.getSnapshot();
      const opened: Promise<boolean> = workspace.open("chapters/one.md");
      const created: Promise<OpenDocument | null> = workspace.create("chapters", "新章节");
      const selected: boolean = workspace.select("document-1");
      const updated: boolean = workspace.update("document-1", "正文");
      const closed: Promise<boolean> = workspace.close("document-1");
      const saved: Promise<boolean> = workspace.save("document-1");
      const savedAll: Promise<boolean> = workspace.saveAll();
      const unsubscribeDocuments = workspace.subscribe(() => void workspace.getSnapshot());
      workspace.clearError();
      void snapshot;
      void opened;
      void created;
      void selected;
      void updated;
      void closed;
      void saved;
      void savedAll;
      unsubscribeDocuments();
      // @ts-expect-error A document snapshot cannot be mutated by a consumer.
      snapshot.documents.push({} as OpenDocument);
    }
    const saveState: DocumentSaveState = "saved";
    const createRequest: DocumentCreateRequest = {sessionId: "session-1", parentPath: "chapters"};
    const revealRequest: DocumentRevealRequest = {sessionId: "session-1", documentId: "document-1"};
    const unsubscribeCreate = pluginContext.on(documentCreateRequested, (request) => {
      const typedRequest: DocumentCreateRequest = request;
      void typedRequest.parentPath;
    });
    const unsubscribeReveal = pluginContext.on(documentRevealRequested, (request) => {
      const typedRequest: DocumentRevealRequest = request;
      void typedRequest.documentId;
    });
    const emittedCreate: Promise<void> = pluginContext.emit(documentCreateRequested, createRequest);
    const emittedReveal: Promise<void> = pluginContext.emit(documentRevealRequested, revealRequest);
    const removeConfig = config.register(testConfig);
    const enabled: boolean = config.getSnapshot(testConfig).enabled;
    const update: Promise<void> = config.set(testConfig, { enabled: false });
    const reset: Promise<void> = config.reset(testConfig);
    const stopConfigListener = config.subscribe(testConfig, () => void config.getSnapshot(testConfig));
    const stopConfigRegistration: () => void = config.register(welcomePage);
    const workbench: WorkbenchService = pluginContext.get(workbenchKey);
    const project: WorkbenchProject = {id: "project", name: "项目", path: "/projects/project"};
    const opening: Promise<boolean> = workbench.openProject(project);
    const closing: Promise<boolean> = workbench.closeProject();
    const removeParticipant: () => Promise<void> = workbench.registerParticipant({
      id: "example.participant",
      start(session: WorkbenchSession) {
        const sessionId: string = session.id;
        const reason: LeaveReason = "close";
        return {
          beforeLeave(nextReason) { const check: LeaveReason = nextReason; return check === reason; },
          dispose() { void sessionId; },
        };
      },
    });
    const active = workbench.getSnapshot().active;
    const session = workbench.getSnapshot().session;
    const removeGuard: () => void = ui.registerNavigationGuard({
      id: "example.navigation",
      prepare(request: UiNavigationRequest) { return request.to.id !== "blocked"; },
    });
    const pageChange: Promise<boolean> = ui.openPage("settings");
    const back: Promise<boolean> = ui.back();
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
    const navigationLayout: NavigationLayoutService = pluginContext.get(navigationLayoutKey);
    const navigationPage: NavigationLayoutPage = {
      id: "example.navigation-page",
      navigation: {label: "示例", icon: "icon", order: 2, group: "secondary"},
      render: ({params, active}) => `${String(params)}:${String(active)}`,
    };
    const removeNavigationPage: () => void = navigationLayout.registerPage(navigationPage);
    // @ts-expect-error Navigation metadata requires an accessible label.
    navigationLayout.registerPage({...navigationPage, navigation: {icon: "icon"}});
    // @ts-expect-error Navigation groups use the public contract.
    navigationLayout.registerPage({...navigationPage, navigation: {label: "错误", group: "tertiary"}});
    removeNavigationPage();
    void ui;
    void enabled;
    void update;
    void reset;
    stopConfigListener();
    removeConfig();
    stopConfigRegistration();
    void opening;
    void closing;
    void active;
    void session;
    void pageChange;
    void back;
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
    unsubscribeCreate();
    unsubscribeReveal();
    void emittedCreate;
    void emittedReveal;
    void saveState;
    removeEditor();
    removeGuard();
    void removeParticipant;
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
void bodyEditorService;

const themeConfig: ThemeConfig = {
  defaultThemeId: "example.ink.dark",
  fallbackThemeIds: { dark: "example.ink.dark", light: "example.paper.light" },
};
void themeConfig;
const jsonConfig: ConfigValue = { values: [null, true, 1, "ok"] };
void jsonConfig;
