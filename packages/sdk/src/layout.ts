import type { ComponentType, ReactNode } from "react";
import { createServiceKey } from "./ServiceKey.js";

/** 内容的用途；不表示上下左右的位置，所有兼容布局必须支持这些用途。 */
export type LayoutRole = "main" | "tabs" | "navigation" | "auxiliary" | "actions" | "status";

/** 内容收到的交互状态；隐藏或工作台不在前台时为 false，应暂停快捷键等交互。 */
export type LayoutContentContext = { readonly active: boolean };

/** 功能插件登记的内容描述；业务数据通过功能自身的服务或 Context 取得。 */
export type LayoutContent = {
  /** 布局内唯一的内容 ID，建议以提供它的插件 ID 为前缀。 */
  readonly id: string;
  /** 用于切换入口、标签和无障碍名称的可读标题。 */
  readonly title: string;
  /** 可选的装饰图标；由内容插件提供，布局可使用默认图标或文字入口，不绑定宿主图标集。 */
  readonly icon?: ReactNode;
  /** 内容用途；布局实现自行决定位置、排列和切换方式。 */
  readonly role: LayoutRole;
  /** 同用途内按升序排列，默认 0；相同值按 ID 的字符串顺序排列。 */
  readonly order?: number;
  /** 返回 React 元素；需要 Hook 时用 JSX 创建组件，不能在此直接调用组件函数。 */
  readonly render: (context: LayoutContentContext) => ReactNode;
};

/** 页面负责提供前台状态；首版一个布局服务供一个工作台页面使用。 */
export type LayoutViewProps = { readonly active: boolean };

/** 不可变快照；状态未变化时返回同一个对象，可用于 useSyncExternalStore。 */
export type LayoutSnapshot = {
  /** 已登记的全部内容，按用途、order、ID 排序；登记时复制描述，后续修改原对象无效。 */
  readonly contents: readonly LayoutContent[];
  /** 布局内部正在展示的内容；页面暂时隐藏不会清空它，内容的 active 还需结合页面状态。 */
  readonly shownIds: readonly string[];
};

/** 可替换布局的公共能力；不承载项目、文档、保存或具体布局尺寸。 */
export type LayoutService = {
  /** 稳定的页面内组件，不创建 React root；已展示内容隐藏时必须保留组件实例。 */
  readonly View: ComponentType<LayoutViewProps>;
  /** 启动期间登记内容，重复 ID 或无效描述抛错；返回幂等、不会影响后续同名登记的撤销函数。 */
  registerContent(content: LayoutContent): () => void;
  /** 展示内容，必要时展开容器或切换标签；main 为单选，展示新 main 时隐藏原 main 并保留其实例。
   * 未知 ID 抛错，不负责切换应用页面或聚焦正文。
   */
  show(id: string): void;
  /** 隐藏内容但保留其组件实例；未知 ID 抛错，布局仍须保留再次展示它的入口。 */
  hide(id: string): void;
  /** 读取布局内部的内容目录与展示状态；停用后访问抛错。 */
  getSnapshot(): LayoutSnapshot;
  /** 订阅快照变化，返回幂等取消函数；页面前台状态通过 View 传入，不属于此快照。 */
  subscribe(listener: () => void): () => void;
};

/** 同一次装配由一个布局插件提供。首版启动后不新增内容；撤销正在使用的贡献须先停止 UI。 */
export const layoutKey = createServiceKey<LayoutService>("app/layout");
