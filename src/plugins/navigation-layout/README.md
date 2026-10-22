# 应用导航布局插件

应用级页面导航布局由本插件提供。默认实现已由 `appPlugins` 静态装配；SDK 契约位于 `@lodestory/sdk/navigation-layout`。欢迎页与设置页的品牌区和导航已从原 `ProjectPageLayout` 移入本插件。窗口外壳 `PageShell` 由独立的 `window-shell` 插件通过 `windowShellKey` 提供。

## 职责与契约

`navigation-layout` 负责欢迎页、设置页等应用级页面的品牌区和导航呈现，不负责页面内容、项目数据、页面切换状态或历史记录。它通过 `@lodestory/sdk/navigation-layout` 提供共享单例 `navigationLayoutKey`，ID 为 `app/navigation-layout`，并依赖 `uiKey` 和 `themeKey`。

`NavigationLayoutPage` 扩展 SDK 的 `UiPage`，附带导航元数据：`navigation: { label, icon?, order?, group?: "primary" | "secondary" }`。分组默认 `primary`，`order` 默认 `0`；默认实现先按分组，再按组内 `order` 升序和页面 ID 字符顺序排列导航入口。`NavigationLayoutService.registerPage(page)` 登记页面并返回撤销函数；插件内部用同一个 `uiKey` 调用 `ui.registerPage`，登记失败不会留下部分条目。点击入口时调用 `ui.openPage(id)`，不传参数；当前页入口不会触发跳转。因此实际路由、历史与导航守卫仍由 UI 插件管理。页面自己的返回按钮仍通过 `ui.back()` 返回。

欢迎页和设置页插件分别登记自己的页面及导航元数据，并声明对 `navigationLayoutKey` 的依赖。其他提供同一 key 契约的插件可以替换布局实现，无需修改页面插件。项目列表状态由 `welcome` 管理；主题偏好和当前主题状态由 `theme` 管理，设置页通过 `theme` 与 `config` 服务读取或修改相关设置。

替代实现须保留页面 ID、`params` 和 `active` 语义，以及切页后已访问页面的组件实例，才能兼容 UI 服务的页面生命周期。

## 生命周期与范围

页面只在启动期间登记。撤销单页时先调用对应的 UI 页面撤销函数；若 UI 已挂载，当前 UI 实现会先卸载整棵 React 树，然后布局插件移除该页面的导航条目。整体停止时，运行时按逆依赖顺序停用插件，页面消费者在各自清理中撤销登记；本插件的清理再按登记逆序撤销残余页面，最后释放布局服务。当前不支持在线热装卸或撤销后自动重新挂载 UI。

应用导航样式位于本插件；页面内容的公共样式仍在 `src/styles.css`，由本插件显式导入。导航布局依赖 `windowShellKey` 并用 `View` 包裹页面，默认保留浏览器模拟标题栏；Tauri 窗口不显示模拟标题栏。`.app-shell` 和 `.window-titlebar` 样式由 `window-shell` 插件管理。工作台编辑页内部布局继续由独立的 `default-layout` 插件提供，两者不共用服务或页面状态。契约细节见 [`@lodestory/sdk` 说明](../../../packages/sdk/README.md)，页面导航和停用关系见[UI 插件说明](../ui/README.md)；[UI 组件包说明](../../../packages/ui/README.md)记录了包和样式的归属。
