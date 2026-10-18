import type {ComponentType} from "react";
import type {ConfigItem} from "./config.js";
import {createServiceKey} from "./ServiceKey.js";

/** 持久化到文档工作区的正文格式。 */
export type EditorFormat = "markdown" | "plain-text" | "rich-delta";

/** 编辑器实例对宿主开放的最小控制能力。 */
export type EditorHandle = Readonly<{
  focus(): void;
}>;

/** 正文编辑器宿主传给格式实现的文档内容与交互状态。 */
export type EditorProps = Readonly<{
  documentId: string;
  format: EditorFormat;
  /** 完整、可持久化的文档内容字符串。 */
  content: string;
  readOnly: boolean;
  active: boolean;
  /** 用户编辑后的完整内容；初始化和纯 UI 状态变化不得触发。 */
  onChange(content: string): void;
  /** 编辑器实例可聚焦时上报句柄，卸载时以 null 清除。 */
  onReady(handle: EditorHandle | null): void;
  /** 编辑器初始化或运行错误；宿主负责显示并保留原始内容。 */
  onError(error: Error): void;
  /** 请求把当前内容另存为指定扩展名的独立文档。 */
  onSaveAs?(request: Readonly<{extension: string; content: string}>): Promise<void>;
}>;

/** 一个编辑器实现声明其支持的格式，并按需异步加载组件。 */
export type EditorDefinition = Readonly<{
  id: string;
  formats: readonly EditorFormat[];
  getText?(content: string, format: EditorFormat): string;
  load(): Promise<{default: ComponentType<EditorProps>}>;
}>;

/** 正文宿主使用的编辑器注册表能力。 */
export type BodyEditorService = {
  /** 登记一个编辑器；返回可重复调用的撤销函数。 */
  registerEditor(definition: EditorDefinition): () => void;
  getText(fileName: string, content: string): string | undefined;
  subscribe(listener: () => void): () => void;
};

/** 正文编辑器注册表能力；宿主与格式插件必须共享同一个 key。 */
export const bodyEditorKey = createServiceKey<BodyEditorService>("app/body-editor");

/** 默认编辑器映射在启动时读取，修改后重启生效。 */
export const bodyEditorDefaultEditorsConfig: ConfigItem<Readonly<Record<string, string>>> = Object.freeze({
  id: "bodyEditor.defaultEditors",
  defaultValue: Object.freeze({markdown: "textarea", "plain-text": "textarea"}),
  effect: "restart",
  validate: (value: unknown): value is Readonly<Record<string, string>> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value).every(([format, id]) =>
      (format === "markdown" || format === "plain-text" || format === "rich-delta")
      && typeof id === "string" && id.trim().length > 0);
  },
});
