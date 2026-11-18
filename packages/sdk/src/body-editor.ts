import type {ComponentType} from "react";
import type {ConfigItem} from "./config.js";
import {createServiceKey} from "./ServiceKey.js";
import type {PluginContribution} from "./Plugin.js";

/** 持久化到文档工作区的正文格式。 */
export type EditorFormat = "plain-text";

/** 正文编辑插件登记到布局服务的主内容 ID；消费者可据此关联正文专属 UI。 */
export const bodyEditorContentIds = Object.freeze({main: "body-editor.main"} as const);

/** 编辑器通过公开契约向宿主贡献的通用正文上下文菜单操作。 */
export type EditorContextMenuAction = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
    /** Disable automatic focus restoration when the action sets its own focus. */
    restoreFocus?: boolean;
    run(): void | Promise<void>;
}>;

/** 编辑器实例对宿主开放的最小控制能力。 */
export type EditorHandle = Readonly<{
    focus(): void;
    /** 同步提交原生输入并返回全文；传入宿主最新内容，以先接纳尚未渲染的外部替换。 */
    flushContent?(currentContent?: string): string;
    /** Reveal a verified range in visible text without changing document content. */
    revealSearchRange?(target: EditorSearchRange): boolean;
    /** 每次调用返回当前可用的菜单操作快照。 */
    getContextMenuActions?(): readonly EditorContextMenuAction[];
}>;
export type EditorSearchRange = Readonly<{text: string; start: number; end: number}>;
export type EditorSearchTarget = Readonly<{documentId: string; content: string; range: EditorSearchRange}>;

/** Replace the exact suffix of the supplied context with insertText. */
export type EditorCompletionCandidate = Readonly<{
    match: string;
    label: string;
    detail?: string;
    insertText: string;
}>;

export type EditorTextSource<Result> = Readonly<{
    isAvailable(): boolean;
    /** Notify synchronously when availability or results change, invalidating previous results. */
    subscribe(listener: () => void): () => void;
    query(text: string, signal: AbortSignal): Promise<readonly Result[]>;
}>;

/** Context contains only text immediately before the caret, within its logical line. */
export type EditorCompletion = EditorTextSource<EditorCompletionCandidate>;

/** A foreground style for a range of UTF-16 offsets relative to the queried text. */
export type EditorHighlight = Readonly<{from: number; to: number; color?: string}>;

/** Accepts the visible document excerpt with surrounding context. Return sorted, disjoint ranges.
 * Color is #RRGGBB, or omitted to use the editor's theme accent.
 */
export type EditorHighlights = EditorTextSource<EditorHighlight>;

/** 正文编辑器宿主传给格式实现的文档内容与交互状态。 */
export type EditorProps = Readonly<{
    documentId: string;
    format: EditorFormat;
    /** 完整、可持久化的文档内容字符串。 */
    content: string;
    readOnly: boolean;
    active: boolean;
    /** Optional completion backed by the active project's registered source. */
    completion?: EditorCompletion;
    highlights?: EditorHighlights;
    /** 用户编辑后的完整内容；初始化和纯 UI 状态变化不得触发。 */
    onChange(content: string): void;
    /** 编辑器实例可聚焦时上报句柄，卸载时以 null 清除。 */
    onReady(handle: EditorHandle | null): void;
    /** 编辑器初始化或运行错误；宿主负责显示并保留原始内容。 */
    onError(error: Error): void;
}>;

/** 一个编辑器实现声明其支持的格式，并按需异步加载组件。 */
export type EditorDefinition = Readonly<{
    id: string;
    formats: readonly EditorFormat[];
    /** 默认由宿主滚动整份文稿；editor 表示获得有界高度，由编辑器管理正文滚动和固定工具栏。 */
    scrollMode?: "document" | "editor";
    getText?(content: string, format: EditorFormat): string;
    /** Visible text used for project search; defaults to getText when omitted. */
    getSearchText?(content: string, format: EditorFormat, signal?: AbortSignal): string | Promise<string>;
    load(): Promise<{ default: ComponentType<EditorProps> }>;
}>;

/** 正文宿主使用的编辑器注册表能力。 */
export type BodyEditorService = {
    /** 登记一个编辑器并将句柄交给 context.track；启动完成后暂不支持单独在线撤回。 */
    registerEditor(definition: EditorDefinition): PluginContribution;
    /** One optional source per project session and format. Dispose before releasing the source. */
    registerCompletionSource(sessionId: string, format: EditorFormat, source: EditorCompletion): () => void;
    /** One optional highlight source per project session and format. */
    registerHighlightSource(sessionId: string, format: EditorFormat, source: EditorHighlights): () => void;
    getText(fileName: string, content: string): string | undefined;
    getSearchText(fileName: string, content: string, signal?: AbortSignal): Promise<string | undefined>;
    revealSearchTarget(sessionId: string, target: EditorSearchTarget): boolean;
    subscribe(listener: () => void): () => void;
};

/** 正文编辑器注册表能力；宿主与格式插件必须共享同一个 key。 */
export const bodyEditorKey = createServiceKey<BodyEditorService>("app/body-editor");

/** 默认编辑器映射在启动时读取，修改后重启生效。 */
export const bodyEditorDefaultEditorsConfig: ConfigItem<Readonly<Record<string, string>>> = Object.freeze({
    id: "bodyEditor.defaultEditors",
    defaultValue: Object.freeze({"plain-text": "plain-text"}),
    effect: "restart",
    validate: (value: unknown): value is Readonly<Record<string, string>> => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && (Object.getPrototypeOf(prototype) !== null
            || prototype.constructor?.name !== "Object")) return false;
        return Object.entries(value).every(([format, id]) =>
            format === "plain-text" && typeof id === "string" && id.trim().length > 0);
    },
});
