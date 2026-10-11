import type {ReactNode} from "react";
import {createServiceKey} from "../plugin-core";

/** 一个插件提供的根包装层；数值较小的 order 在外层，相同值保持登记顺序。 */
export type UiWrapper = {
    readonly id: string;
    readonly order: number;
    readonly wrap: (children: ReactNode) => ReactNode;
};

/**
 * UI 插件提供的启动期登记能力；使用者须在 requires 中声明 uiKey。
 * 登记必须在 activate 中完成；ready 后由 UI 插件统一渲染，使用者不自行 createRoot。
 */
export type UiService = {
    /** 登记唯一根视图，保存函数而不立即调用；返回可重复调用的撤销函数。 */
    setRoot(render: () => ReactNode): () => void;
    /** 登记包装规则，保存函数而不立即调用；返回可重复调用的撤销函数。 */
    addWrapper(wrapper: UiWrapper): () => void;
};

/**
 * 提供者和使用者共享这个标识。使用者在 deactivate 中撤销自己的登记，
 * 再释放组件使用的资源；撤销已挂载贡献会先卸载整棵树，本版不支持运行中重组。
 */
export const uiKey = createServiceKey<UiService>("app/ui");
