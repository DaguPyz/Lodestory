import type {Plugin} from "@lodestory/sdk";
import {createErrorUiPlugin} from "../plugins/error-ui";
import {createUiPlugin} from "../plugins/ui";
import {createThemePlugin} from "../plugins/theme/themePlugin";
import {createBuiltinThemesPlugin} from "../plugins/builtin-themes";
import {createDefaultLayoutPlugin} from "../plugins/default-layout/defaultLayoutPlugin";
import {createContextMenuPlugin} from "../plugins/context-menu";
import {createWelcomePlugin} from "../plugins/welcome/welcomePlugin";
import {createWorkbenchPlugin} from "../plugins/workbench/workbenchPlugin";
import {createDocumentsPlugin} from "../plugins/documents/documentsPlugin";
import {createProjectManagementPlugin} from "../plugins/project-management/projectManagementPlugin";
import {createBodyEditorPlugin} from "../plugins/body-editor/bodyEditorPlugin";
import {createMarkdownEditorPlugin} from "../plugins/markdown-editor/markdownEditorPlugin";
import {createDocumentTabsPlugin} from "../plugins/document-tabs/documentTabsPlugin";
import {createWritingStatusPlugin} from "../plugins/writing-status/writingStatusPlugin";
import {createWorkbenchToolbarPlugin} from "../plugins/workbench-toolbar/workbenchToolbarPlugin";
import {createConfigPlugin} from "../plugins/config/configPlugin";
import {createSettingsPlugin} from "../plugins/settings/settingsPlugin";

/** 应用选择哪些插件；启动和渲染流程不根据具体插件添加分支。 */
export function createAppPlugins(): readonly Plugin[] {
    return [
        createConfigPlugin(),
        createErrorUiPlugin(),
        createUiPlugin(),
        createThemePlugin(),
        createBuiltinThemesPlugin(),
        createContextMenuPlugin(),
        createDefaultLayoutPlugin(),
        createWorkbenchPlugin(),
        createDocumentsPlugin(),
        createProjectManagementPlugin(),
        createBodyEditorPlugin(),
        createMarkdownEditorPlugin(),
        createDocumentTabsPlugin(),
        createWritingStatusPlugin(),
        createWorkbenchToolbarPlugin(),
        createWelcomePlugin(),
        createSettingsPlugin(),
    ];
}
