# UI 插件

`createUiPlugin` 把页面导航和 React 根节点装配合并为一个插件，并提供 `uiKey`。页面插件与 Provider 插件在 `activate` 中通过 `uiKey` 登记页面或包装层；登记时只保存配置，不创建根节点。

公共生命周期类型位于 [`@lodestory/sdk`](../../../packages/sdk/src/Plugin.ts)，UI 能力与页面类型位于 [`@lodestory/sdk/ui`](../../../packages/sdk/src/ui.ts)。`createUiPlugin` 与 `pluginsReady` 仍是宿主运行时实现；SDK 目前只提供同一 JavaScript realm 内的契约，不提供运行中热登记 API。

启动到 `pluginsReady` 后，UI 插件选择 `initialPage`（未指定时用第一个登记页面），按包装层的 `order` 组装 Provider 与通用页面容器，再创建一个 React root。数值较小的 `order` 位于外层。页面调用 `openPage(id, params)` 切换并记录历史，页面收到自己的 `params`；`back()` 返回上一页并恢复它的参数。已访问页面继续留在树中，只隐藏非当前页面，因此切换时会保留其 React 组件实例和 Hook 状态。

本版只允许在 `pluginsReady` 前登记贡献，运行中不支持增删或重新挂载：撤销任一已挂载页面或包装层都会先卸载整棵 UI 树，之后不会自动重建。贡献插件的 `deactivate` 应先调用登记时保存的 disposer，再释放它提供给组件使用的资源；正常整体停止时 UI 插件按生命周期卸载 React root，再清理登记和导航状态。

UI 树发生未捕获的 React 渲染错误时，UI 插件会把同一个 root 切换到独立的 `UiErrorPage`，替换故障组件树并保留已激活插件及其服务。这个恢复只处理显示故障，不定位或停用某个业务插件；当前没有组件到插件的故障归属信息，边界插件后续再做。若真正的启动过程失败（例如插件激活或 `createRoot` 失败），内核会先回滚已激活插件，启动 Promise 拒绝后 `main.tsx` 再调用 UI 模块的 `showUiStartupError` 显示 DOM 兜底页；若回滚也失败，报告会同时保留原始启动错误和回滚错误。正常停止、渲染恢复和启动失败因此走不同的处理路径。

页面的 `render` 回调应返回 React 元素；若页面组件使用 Hook，要通过 JSX 创建它，不要直接调用组件函数：

```tsx
import {useState} from "react";
import type {Plugin} from "@lodestory/sdk";
import {uiKey} from "@lodestory/sdk/ui";

function SettingsPage() {
    const [draft, setDraft] = useState("");
    return <main><input value={draft} onChange={(event) => setDraft(event.currentTarget.value)}/></main>;
}

export function createSettingsPlugin(): Plugin {
    let removePage: (() => void) | undefined;

    return {
        id: "settings",
        requires: [uiKey],
        provides: [],
        activate(context) {
            removePage = context.get(uiKey).registerPage({
                id: "settings",
                render: () => <SettingsPage />,
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
