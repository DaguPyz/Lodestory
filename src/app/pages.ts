import type {WorkbenchProject} from "@lodestory/sdk/workbench";

/** 应用页面之间共享的 ID 与参数约定；通用 UI 插件不依赖这些业务标识。 */
export const appPages = {
    welcome: "welcome",
    editor: "editor",
} as const;

export type EditorPageParams = {
    readonly project: WorkbenchProject;
};
