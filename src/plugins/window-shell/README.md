# 窗口外壳插件

`window-shell` 提供应用窗口的通用外框，不拥有页面导航或业务内容。它把原 `src/components/PageShell.tsx` 移到插件内，并通过 `@lodestory/sdk/window-shell` 提供公开服务。

## 契约与接入

SDK 导出共享单例 `windowShellKey`（ID：`app/window-shell`）、`WindowShellProps` 和 `WindowShellService`。属性为 `{ children, showBrowserTitlebar?: boolean }`；服务提供 `readonly View: ComponentType<WindowShellProps>`。插件声明对 `themeKey` 的依赖，并提供稳定的 `PageShell` 组件。默认实现已由 `appPlugins` 静态选择。

`navigation-layout` 和 `workbench` 声明对 `windowShellKey` 的依赖，再通过 `context.get(windowShellKey).View` 包装页面内容。导航页使用默认标题栏设置；工作台传入 `showBrowserTitlebar={false}`。该选项只控制浏览器里的模拟标题栏，Tauri 原生窗口始终不显示模拟标题栏。

同一次插件激活期间，`View` 的组件身份保持稳定，普通更新和页面切换不会重挂载 `children`。替换实现由下一次 `appPlugins` 静态装配选择；不承诺跨实现或应用重启保留 React 实例。插件本身不创建 React root；服务也不保存为全局单例。窗口外框和标题栏没有事件监听或计时器，组件资源由 React 管理挂载与卸载。

## 生命周期与样式

应用启动时由 `appPlugins` 静态装配默认实现。消费者依赖 `windowShellKey`，因此停止时会先撤销各自的 UI 页面；Core 随后撤销此插件提供的能力。插件无需定义空 `deactivate`，也没有需要单独清理的外部资源。此生命周期不提供运行中热装卸保证。

本插件拥有 `PageShell` 和 `window-shell.css` 中的 `.app-shell`、`.window-titlebar` 样式。通用样式继续放在 `src/styles.css`；`navigation-layout` 和 `workbench` 显式导入它，不再借窗口外壳组件带入。

契约见 [`@lodestory/sdk` 说明](../../../packages/sdk/README.md)，调用方见[UI 插件说明](../ui/README.md)和[应用导航布局说明](../navigation-layout/README.md)。
