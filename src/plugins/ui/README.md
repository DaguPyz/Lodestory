# UI 插件

`createUiPlugin` 把页面导航和 React 根节点装配合并为一个插件，并提供 `uiKey`。页面插件与 Provider 插件在 `activate` 中通过 `uiKey` 登记页面或包装层；登记时只保存配置，不创建根节点。

启动到 `pluginsReady` 后，UI 插件选择 `initialPage`（未指定时用第一个登记页面），按包装层的 `order` 组装 Provider 与通用页面容器，再创建一个 React root。数值较小的 `order` 位于外层。页面调用 `openPage(id, params)` 切换并记录历史，页面收到自己的 `params`；`back()` 返回上一页并恢复它的参数。已访问页面继续留在树中，只隐藏非当前页面，因此切换时会保留其 React 组件实例和 Hook 状态。

本版只允许在 `pluginsReady` 前登记贡献，运行中不支持增删或重新挂载：撤销任一已挂载页面或包装层都会先卸载整棵 UI 树，之后不会自动重建。贡献插件的 `deactivate` 应先调用登记时保存的 disposer，再释放它提供给组件使用的资源；整体停用时 UI 插件也先卸载 React root，再清理登记和导航状态。

页面的 `render` 回调应返回 React 元素；若页面组件使用 Hook，要通过 JSX 创建它，不要直接调用组件函数：

```tsx
import {useState} from "react";
import type {Plugin} from "../../plugin-core";
import {uiKey} from "../ui";

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
