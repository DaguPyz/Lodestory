import type {ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";
import type {UiPage} from "./ui.js";

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

/**
 * 应用级导航布局；实际页面、历史和导航守卫仍由 UI 服务管理。
 * 替代实现必须保留页面 ID、params、active，以及切页时已访问页面的组件实例。
 * 选择导航入口通过 ui.openPage(id) 打开页面，不携带参数；同一当前页入口不跳转。
 */
export type NavigationLayoutService = {
    /**
     * 启动期同时登记导航和 UI 页面；重复 ID 或无效描述抛错，失败不留下部分登记。
     * 返回幂等撤销函数，旧句柄不影响后续同名登记。撤销先停止消费页面资源的 UI，
     * 再移除布局登记；首版沿用 UI 的整树卸载规则，不支持运行中增删。
     */
    registerPage(page: NavigationLayoutPage): () => void;
};

/** 默认实现由应用显式装配；页面插件声明依赖并导入同一个 key。 */
export const navigationLayoutKey = createServiceKey<NavigationLayoutService>("app/navigation-layout");
