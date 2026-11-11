import type {ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";
import type {UiPage} from "./ui.js";
import type {PluginContribution} from "./Plugin.js";

/** 导航用途分组；具体位置由布局实现决定，不表示固定的上下左右。 */
export type NavigationGroup = "primary" | "secondary";

/** 页面插件贡献的导航信息；图标只作装饰，label 同时作为可访问名称。 */
export type NavigationItem = {
    readonly label: string;
    readonly icon?: ReactNode;
    /** 默认 primary；默认实现将辅助入口与主要入口分开呈现。 */
    readonly group?: NavigationGroup;
    /** 同组内按升序排列，默认 0；相同值按页面 ID 的字符串顺序排列。 */
    readonly order?: number;
};

/** 页面内容与导航一并登记；布局不得在登记期间调用 render。 */
export type NavigationLayoutPage = UiPage & {
    readonly navigation: NavigationItem;
};

/** A navigation entry that performs an action without switching the current page. */
export type NavigationLayoutAction = {
    readonly id: string;
    readonly navigation: NavigationItem;
    readonly run: () => void | Promise<void>;
};

/**
 * 应用级导航布局；实际页面、历史和导航守卫仍由 UI 服务管理。
 * 替代实现必须保留页面 ID、params、active，以及切页时已访问页面的组件实例。
 * 页面入口通过 ui.openPage(id) 打开页面；操作入口执行贡献者的回调，不改变当前页面。
 */
export type NavigationLayoutService = {
    /**
     * 同时登记导航和 UI 页面；重复 ID 或无效描述抛错，失败不留下部分登记。
     * 返回生命周期句柄，须交给 context.track。在线停用先经导航守卫离开当前页面，
     * 再撤回页面和导航登记；根视图与其他页面保留。
     */
    registerPage(page: NavigationLayoutPage): PluginContribution;
    /** Validate and publish a group of new pages as one operation. */
    registerPages(pages: readonly NavigationLayoutPage[]): readonly PluginContribution[];
    /** 登记独立操作；与页面共享 ID 空间，撤销时同步更新现有导航。 */
    registerAction(action: NavigationLayoutAction): PluginContribution;
};

/** 默认实现由应用显式装配；页面插件声明依赖并导入同一个 key。 */
export const navigationLayoutKey = createServiceKey<NavigationLayoutService>("app/navigation-layout");
export const navigationLayoutExternalCapability = Object.freeze({id: "lodestory/navigation-layout@0", version: "0.1.0"});
