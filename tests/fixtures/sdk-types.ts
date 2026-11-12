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
import {settingsKey, type SettingsService} from "@lodestory/sdk/settings";
import {shortcutsKey, ShortcutConflictError, type ShortcutsService} from "@lodestory/sdk/shortcuts";
import {windowShellKey, type WindowShellProps, type WindowShellService} from "@lodestory/sdk/window-shell";
import { uiKey, type UiService } from "@lodestory/sdk/ui";
import type { UiNavigationRequest } from "@lodestory/sdk/ui";
import { errorUiKey, type ErrorUiService } from "@lodestory/sdk/error";
import { themeKey, type ThemeConfig, type ThemeService } from "@lodestory/sdk/theme";
import { workbenchKey, type LeaveReason, type WorkbenchProject, type WorkbenchService, type WorkbenchSession } from "@lodestory/sdk/workbench";
import { configKey, type ConfigItem, type ConfigService, type ConfigValue } from "@lodestory/sdk/config";
import {nativeLibraryLoaderKey, type NativeLibraryInstance, type NativeLibraryResponse} from "@lodestory/sdk/native-library-loader";
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
  projectStorageKey,
  type ProjectStorageService,
  type ProjectFiles,
  type ProjectFile,
  type ProjectDirectoryListing,
} from "@lodestory/sdk/project-storage";
import {
  bodyEditorKey,
  bodyEditorContentIds,
  type BodyEditorService,
  type EditorDefinition,
  type EditorFormat,
  type EditorHandle,
  type EditorProps,
} from "@lodestory/sdk/body-editor";
import {
  canvasKey,
  type CanvasService,
  type CanvasViewport,
  type CanvasViewportSnapshot,
  type CanvasSurfaceProps,
  type CanvasZoomAnchor,
} from "@lodestory/sdk/canvas";
import {timelineKey, type TimelineListModel, type TimelineListSnapshot, type TimelineService} from "@lodestory/sdk/timeline";

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
    return Object.assign(() => {}, {associate() {}, check() {}, withdraw() {}});
  },
  getText(fileName, content) {
    void fileName;
    return content;
  },
  async getSearchText(fileName, content) {
    void fileName;
    return content;
  },
  revealSearchTarget(sessionId, target) { void sessionId; void target; return false; },
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
  requires: [documentKey, uiKey, errorUiKey, themeKey, layoutKey, navigationLayoutKey, settingsKey, shortcutsKey, windowShellKey, workbenchKey, configKey, projectStorageKey, documentsKey, bodyEditorKey, canvasKey, timelineKey],
  provides: [],
  activate(pluginContext) {
    const document = pluginContext.get(documentKey);
    const text: string = document.read();
    const ui: UiService = pluginContext.get(uiKey);
    const config: ConfigService = pluginContext.get(configKey);
    const shortcuts: ShortcutsService = pluginContext.get(shortcutsKey);
    const binding = shortcuts.getSnapshot().bindings[0];
    if (binding) {
      const defaultKeys: string = binding.defaultKeys;
      const defaultLabel: string = binding.defaultLabel;
      const customized: boolean = binding.customized;
      // @ts-expect-error Shortcut snapshots are immutable to consumers.
      binding.customized = false;
      void defaultKeys; void defaultLabel; void customized;
    }
    const conflict = new ShortcutConflictError("binding", "scope", "Mod+S", ["other"]);
    const conflicts: readonly string[] = conflict.conflictingBindingIds;
    void conflicts;
    const documents: DocumentsService = pluginContext.get(documentsKey);
    const storage: ProjectStorageService = pluginContext.get(projectStorageKey);
    const bodyEditor: BodyEditorService = pluginContext.get(bodyEditorKey);
    const canvas: CanvasService = pluginContext.get(canvasKey);
    const timelines: TimelineService = pluginContext.get(timelineKey);
    const timelineModel: TimelineListModel | null = timelines.getModel("session-1");
    if (timelineModel) {
      const timelineSnapshot: TimelineListSnapshot = timelineModel.getSnapshot();
      const unsubscribeTimeline = timelineModel.subscribe(() => void timelineModel.getSnapshot());
      timelineModel.beginCreate();
      timelineModel.updateCreateDraft({title: "新时间线", summary: "故事梗概"});
      timelineModel.cancelCreate();
      const createTimeline: Promise<boolean> = timelineModel.create();
      const deleteTimeline: Promise<boolean> = timelineModel.remove("timeline-id");
      const retryTimeline: Promise<boolean> = timelineModel.retry();
      const saveTimeline: Promise<boolean> = timelineModel.save("timeline-id");
      // @ts-expect-error Timeline selection is changed through the service's guarded open command.
      timelineModel.select("timeline-id");
      // @ts-expect-error Timeline navigation consumers cannot dispose the timeline-owned model.
      timelineModel.dispose();
      // @ts-expect-error Timeline snapshots are immutable to consumers.
      timelineSnapshot.entries.push({} as TimelineListSnapshot["entries"][number]);
      unsubscribeTimeline();
      void createTimeline; void deleteTimeline; void retryTimeline; void saveTimeline;
    }
    const openedTimeline: boolean = timelines.open("session-1", "timeline-id");
    const mainContentId: "body-editor.main" = bodyEditorContentIds.main;
    const viewport: CanvasViewport = canvas.createViewport({center: {x: 0, y: 0}, zoom: 1});
    const viewportState: CanvasViewportSnapshot = viewport.getSnapshot();
    const anchor: CanvasZoomAnchor = {point: {x: 120, y: 80}, size: {width: 480, height: 320}};
    const acceptedPan: boolean = viewport.panBy(24, -12);
    const acceptedZoom: boolean = viewport.zoomTo(1.5, anchor);
    const resetZoom: boolean = viewport.resetZoom();
    const resetView: boolean = viewport.resetView();
    const unsubscribeViewport: () => void = viewport.subscribe(() => void viewport.getSnapshot());
    const surfaceProps: CanvasSurfaceProps = {viewport, active: true, label: "Timeline"};
    void canvas.Surface;
    void openedTimeline;
    void mainContentId;
    void viewportState;
    void acceptedPan;
    void acceptedZoom;
    void resetZoom;
    void resetView;
    void surfaceProps;
    unsubscribeViewport();
    viewport.dispose();
    // @ts-expect-error Canvas viewport snapshots are read-only.
    viewportState.zoom = 2;
    // @ts-expect-error Canvas service exposes generic viewports, not outline business data.
    canvas.createTimeline("timeline-1");
    const removeEditor: () => void = bodyEditor.registerEditor({
      id: "example.plain-text",
      formats: ["plain-text"],
      getText(content: string, format: EditorFormat): string {
        const plainTextFormat: "plain-text" = format;
        void plainTextFormat;
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
          void active;
          void readOnly;
          return null;
        };
        return {default: Editor};
      },
    });
    // @ts-expect-error Markdown is not a supported editor format.
    bodyEditor.registerEditor({id: "example.markdown", formats: ["markdown"], async load() { return {default: () => null}; }});
    const workspace: DocumentWorkspace | null = documents.getWorkspace("session-1");
    // @ts-expect-error Generic files do not belong to DocumentsService.
    documents.getFiles("session-1");
    // @ts-expect-error Storage does not define business resources or directory layouts.
    storage.getResources("session-1", "outline-design", "timelines");
    const files: ProjectFiles | null = storage.getFiles("session-1");
    if (files) {
      const reading: Promise<ProjectFile | null> = files.read("any/path.bin");
      const creating: Promise<ProjectFile | null> = files.create("any/path.bin", new Uint8Array([0, 255]), {createParents: true});
      const writing: boolean = files.write("any/path.bin", [255, 0]);
      const saving: Promise<boolean> = files.save("any/path.bin");
      const listing: Promise<ProjectDirectoryListing | null> = files.list("any");
      const deleting: Promise<boolean> = files.delete("any/path.bin", {discardChanges: true});
      // @ts-expect-error Byte snapshots cannot be changed outside storage operations.
      files.getSnapshot().files[0].bytes.push(1);
      // @ts-expect-error Text decoding belongs to the caller.
      files.getSnapshot().files[0].content = "bypass";
      // @ts-expect-error Storage cannot accept strings as file contents.
      files.write("any/path.bin", "text");
      void reading; void creating; void writing; void saving; void listing; void deleting;
    }
    if (workspace) {
      const snapshot: DocumentSnapshot = workspace.getSnapshot();
      const opened: Promise<boolean> = workspace.open("chapters/one.txt");
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
    const pageChange: Promise<boolean> = ui.openPage("welcome");
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
    const settings: SettingsService = pluginContext.get(settingsKey);
    const removeSection: () => void = settings.registerSection({id: "example.section", group: "示例", title: "示例", render: () => "设置内容"});
    const settingsOpened: boolean = settings.open("example.section");
    const removeNavigationAction: () => void = navigationLayout.registerAction({id: "example.action", navigation: {label: "打开"}, run: () => { settings.open(); }});
    // @ts-expect-error Settings sections must provide a rendering function.
    settings.registerSection({id: "bad", group: "示例", title: "错误"});
    void settingsOpened;
    removeNavigationAction();
    removeSection();
    const windowShell: WindowShellService = pluginContext.get(windowShellKey);
    const shellProps: WindowShellProps = {children: "page content", showBrowserTitlebar: false};
    const WindowShell: WindowShellService["View"] = windowShell.View;
    const shellChildren: WindowShellProps["children"] = shellProps.children;
    const showTitlebar: boolean | undefined = shellProps.showBrowserTitlebar;
    void WindowShell;
    void shellChildren;
    void showTitlebar;
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

async function nativeLibraryTypes(pluginContext: PluginContext) {
  const backend: NativeLibraryInstance = await pluginContext.get(nativeLibraryLoaderKey).load("/library");
  const response: NativeLibraryResponse = await backend.call({requestId: "one", operation: "ping", schemaVersion: "1.0.0", params: {text: "hello"}});
  if (response.status === "error") {const code: string = response.error.code; void code;}
  await backend.close();
  // @ts-expect-error Dynamic-library requests require a schema version.
  await backend.call({requestId: "one", operation: "ping", params: null});
}
void nativeLibraryTypes;
