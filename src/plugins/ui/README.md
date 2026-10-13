# UI 插件

`createUiPlugin` 把页面导航和 React 根节点装配合并为一个插件，并提供 `uiKey`。生产应用通过无参的 `createUiPlugin()` 创建它；到 `pluginsReady` 时，UI 插件自行查找 `#root`，并按首个登记页面选择初始页。当前应用先登记 welcome 页，因此默认仍进入 welcome。独立宿主或测试可以显式传入容器和选项。

公共生命周期类型位于 [`@lodestory/sdk`](../../../packages/sdk/src/Plugin.ts)，UI 能力与页面类型位于 [`@lodestory/sdk/ui`](../../../packages/sdk/src/ui.ts)。`createUiPlugin` 与 `pluginsReady` 仍是宿主运行时实现；SDK 目前只提供同一 JavaScript realm 内的契约，不提供运行中热登记 API。

启动到 `pluginsReady` 后，UI 插件选择显式配置的 `initialPage`；未指定时用第一个登记页面。随后它按包装层的 `order` 组装 Provider 与通用页面容器，再创建一个 React root。数值较小的 `order` 位于外层。页面调用 `openPage(id, params)` 切换并记录历史，页面收到自己的 `params`；`back()` 返回上一页并恢复它的参数。已访问页面继续留在树中，只隐藏非当前页面，因此切换时会保留其 React 组件实例和 Hook 状态。

本版只允许在 `pluginsReady` 前登记贡献，运行中不支持增删或重新挂载：撤销任一已挂载页面或包装层都会先卸载整棵 UI 树，之后不会自动重建。贡献插件的 `deactivate` 应先调用登记时保存的 disposer，再释放它提供给组件使用的资源；正常整体停止时 UI 插件按生命周期卸载 React root，再清理登记和导航状态。

`error-ui` 插件通过 `errorUiKey` 提供稳定的 `ErrorBoundary` 错误边界和 `ErrorView`。UI 插件依赖该服务，并用 `ErrorBoundary` 包住根下的 Provider 与页面树；页面插件也可以在自己的页面内容周围使用 `ErrorBoundary`，让局部错误只替换对应页面内容。插件是否被卸载仍由运行时生命周期决定，错误边界只负责渲染错误视图。

如果 React 的错误没有被 `ErrorBoundary` 捕获并到达根的 `onUncaughtError`，UI 插件会在同一个 root 用内置的简单错误界面替换当前树，不卸载 root 或已激活插件。这个最后兜底只恢复显示，不定位或停用某个业务插件。若真正的启动过程失败（例如插件激活或 `createRoot` 失败），内核会先回滚已激活插件，启动 Promise 拒绝后 `main.tsx` 调用 UI 模块的 `showUiStartupError` 显示 DOM 兜底页；该模块自行查找 `#root`，若根容器不存在则只报告原始启动错误与回滚错误，不会因再次渲染失败而抛错。正常停止、边界内错误、根级错误恢复和启动失败因此走不同的处理路径。

页面的 `render` 回调应返回 React 元素；若页面组件使用 Hook，要通过 JSX 创建它，不要直接调用组件函数：

```tsx
import {useState} from "react";
import type {Plugin} from "@lodestory/sdk";
import {uiKey} from "@lodestory/sdk/ui";
import {errorUiKey} from "@lodestory/sdk/error";

function SettingsPage() {
    const [draft, setDraft] = useState("");
    return <main><input value={draft} onChange={(event) => setDraft(event.currentTarget.value)}/></main>;
}

export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey, errorUiKey],
        provides: [],
        activate(context) {
            const {ErrorBoundary} = context.get(errorUiKey);
            removePage = context.get(uiKey).registerPage({
                id: "settings",
                render: () => <ErrorBoundary><SettingsPage /></ErrorBoundary>,
            });
        },
        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
```

应用通过 `welcome`、`editor`、`settings` 三个插件分别登记欢迎页、编辑页和设置页，初始页面为 `welcome`。页面之间使用 `openPage` 与 `back` 导航，旧的 `App` 和 `workspace` 接入已移除。

欢迎页打开项目后将项目作为编辑页参数传入；编辑页进入设置或返回欢迎页前先保存文档，保存失败则留在编辑页。从设置返回时恢复来源页面，编辑页组件保持挂载；切换项目时按项目 ID 和路径重建编辑实例。页面内部的文件树、工具栏、正文和对话框仍保留为页面组件。当前页面及内部组件位于各自插件目录，共享布局位于 `src/components`。
