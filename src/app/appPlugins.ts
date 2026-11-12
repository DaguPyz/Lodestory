import type {Plugin} from "@lodestory/sdk";
import {createErrorUiPlugin} from "../plugins/error-ui";
import {createUiPlugin} from "../plugins/ui";
import {createUiInteractionPlugin} from "../plugins/ui-interaction";
import {createThemePlugin} from "../plugins/theme/themePlugin";
import {createBuiltinThemesPlugin} from "../plugins/builtin-themes";
import {createDefaultLayoutPlugin} from "../plugins/default-layout/defaultLayoutPlugin";
import {createNavigationLayoutPlugin} from "../plugins/navigation-layout/navigationLayoutPlugin";
import {createWindowShellPlugin} from "../plugins/window-shell/windowShellPlugin";
import {createContextMenuPlugin} from "../plugins/context-menu";
import {createWelcomePlugin} from "../plugins/welcome/welcomePlugin";
import {createWorkbenchPlugin} from "../plugins/workbench/workbenchPlugin";
import {createDocumentsPlugin} from "../plugins/documents/documentsPlugin";
import {createProjectStoragePlugin} from "../plugins/project-storage/projectStoragePlugin";
import {createBackgroundTasksPlugin} from "../plugins/background-tasks/backgroundTasksPlugin";
import {createNativeProcessLoaderPlugin} from "../plugins/native-process-loader/nativeProcessLoaderPlugin";
import {createNativeLibraryLoaderPlugin} from "../plugins/native-library-loader/nativeLibraryLoaderPlugin";
import {createProjectManagementPlugin} from "../plugins/project-management/projectManagementPlugin";
import {createOutlineDesignPlugin} from "../plugins/outline-design/outlineDesignPlugin";
import {createAssetManagementPlugin} from "../plugins/asset-management/assetManagementPlugin";
import {createCanvasPlugin} from "../plugins/canvas/canvasPlugin";
import {createTimelinePlugin} from "../plugins/timeline/timelinePlugin";
import {createBodyEditorPlugin} from "../plugins/body-editor/bodyEditorPlugin";
import {createPlainTextEditorPlugin} from "../plugins/plain-text-editor/plainTextEditorPlugin";
import {createDocumentTabsPlugin} from "../plugins/document-tabs/documentTabsPlugin";
import {createWritingStatusPlugin} from "../plugins/writing-status/writingStatusPlugin";
import {createWorkbenchToolbarPlugin} from "../plugins/workbench-toolbar/workbenchToolbarPlugin";
import {createConfigPlugin} from "../plugins/config/configPlugin";
import {createSettingsPlugin} from "../plugins/settings/settingsPlugin";
import {createProjectSearchPlugin} from "../plugins/project-search/projectSearchPlugin";
import {createDocumentSearchPlugin} from "../plugins/document-search/documentSearchPlugin";
import {createShortcutsPlugin} from "../plugins/shortcuts";
import {createPluginPackagesPlugin} from "../plugins/plugin-packages/pluginPackagesPlugin";
import {createPluginManagementPlugin} from "../plugins/plugin-management/pluginManagementPlugin";
import {createExternalPluginsPlugin} from "../plugins/external-plugins/externalPluginsPlugin";

/** 应用选择哪些插件；启动和渲染流程不根据具体插件添加分支。 */
export function createAppPlugins(): readonly Plugin[] {
    return [
        createConfigPlugin(),
        createErrorUiPlugin(),
        createPluginPackagesPlugin(),
        createUiPlugin(),
        createUiInteractionPlugin(),
        createShortcutsPlugin(),
        createThemePlugin(),
        createBuiltinThemesPlugin(),
        createContextMenuPlugin(),
        createWindowShellPlugin(),
        createNavigationLayoutPlugin(),
        createDefaultLayoutPlugin(),
        createWorkbenchPlugin(),
        createProjectSearchPlugin(),
        createProjectStoragePlugin(),
        createBackgroundTasksPlugin(),
        createNativeProcessLoaderPlugin(),
        createNativeLibraryLoaderPlugin(),
        createDocumentsPlugin(),
        createProjectManagementPlugin(),
        createCanvasPlugin(),
        createTimelinePlugin(),
        createOutlineDesignPlugin(),
        createAssetManagementPlugin(),
        createBodyEditorPlugin(),
        createPlainTextEditorPlugin(),
        createDocumentSearchPlugin(),
        createDocumentTabsPlugin(),
        createWritingStatusPlugin(),
        createWorkbenchToolbarPlugin(),
        createWelcomePlugin(),
        createSettingsPlugin(),
        createExternalPluginsPlugin(),
        createPluginManagementPlugin(),
    ];
}
