import type {ReactNode} from "react";
import {createServiceKey} from "../../plugin-core";

/** 一个插件提供的根包装层；数值较小的 order 在外层，相同值保持登记顺序。 */
export type UiWrapper = {
    readonly id: string;
    readonly order: number;
    readonly wrap: (children: ReactNode) => ReactNode;
};

/** 页面收到自己的参数和显示状态；隐藏时应暂停页面快捷键等交互。 */
export type UiPageContext = {
    readonly params: unknown;
    readonly active: boolean;
};

/** 由页面插件登记的视图；切页保留已访问页面的组件实例。 */
export type UiPage = {
    readonly id: string;
    readonly render: (context: UiPageContext) => ReactNode;
};

export type UiLocation = {
    readonly id: string;
    readonly params: unknown;
};

export type UiPageView = UiPage & UiPageContext;

/** 状态不变时返回同一个快照；pages 仅包含已经访问过的页面。 */
export type UiSnapshot = {
    readonly current: UiLocation | null;
    readonly pages: readonly UiPageView[];
    readonly canGoBack: boolean;
};

/**
 * 合并页面管理与根装配的 UI 能力；使用者须在 requires 中声明 uiKey。
 * 页面和包装层在 activate 中登记；ready 后可切页，使用者不自行 createRoot。
 */
export type UiService = {
    /** 登记页面，保存函数而不立即调用；返回可重复调用的撤销函数。 */
    registerPage(page: UiPage): () => void;
    /** 登记包装规则，保存函数而不立即调用；返回可重复调用的撤销函数。 */
    addWrapper(wrapper: UiWrapper): () => void;
    /** 切换到已登记页面，传入参数，并记录上一页；仅在 ready 后可用。 */
    openPage(id: string, params?: unknown): void;
    /** 恢复上一页及其参数；没有上一页时不改变状态。 */
    back(): void;
    /** 读取页面显示状态。 */
    getSnapshot(): UiSnapshot;
    /** 订阅页面状态变化，返回取消订阅函数。 */
    subscribe(listener: () => void): () => void;
};

/**
 * 提供者和使用者共享这个标识。使用者在 deactivate 中撤销自己的登记，
 * 再释放组件使用的资源；撤销已挂载贡献会先卸载整棵树，本版不支持运行中增删贡献。
 */
export const uiKey = createServiceKey<UiService>("app/ui");
