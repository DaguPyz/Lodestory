import type {ComponentType, ReactNode} from "react";
import {createServiceKey} from "./ServiceKey.js";

/** 窗口外壳接收页面内容；标题栏开关只控制浏览器内的模拟标题栏。 */
export type WindowShellProps = {
    readonly children: ReactNode;
    /** 默认 true；Tauri 运行时不渲染该模拟标题栏。 */
    readonly showBrowserTitlebar?: boolean;
};

/**
 * 应用级窗口外壳；页面由 UI 服务登记，外壳不创建 React root 或管理导航。
 * 同一次激活期间 View 的组件身份必须稳定，普通重绘与切页不得重建 children。
 * 使用者声明 windowShellKey 依赖，并在释放页面资源前撤销自己的 UI 登记。
 */
export type WindowShellService = {
    readonly View: ComponentType<WindowShellProps>;
};

/** 默认实现由应用显式装配；提供者和消费者共享同一个 key 实例。 */
export const windowShellKey = createServiceKey<WindowShellService>("app/window-shell");
