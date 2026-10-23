# 公共右键菜单

应用通过 `createContextMenuPlugin()` 登记 `ContextMenuProvider`，UI 装配插件收到 `pluginsReady` 后把它放在根视图外层。独立组件示例仍可以直接挂载一次 Provider。页面通过 `ContextMenuRegion` 传入触发元素、菜单配置和可选上下文；组件不依赖项目、文档或 Tauri 业务接口。

```tsx
import { ContextMenuRegion, type MenuEntry } from "./plugins/context-menu";

type Target = { id: string; title: string; readOnly: boolean };

const items: MenuEntry<Target>[] = [
  {
    id: "open",
    label: "打开",
    disabled: (target) => target.readOnly,
    onSelect: (target) => openTarget(target.id),
    restoreFocus: false,
  },
];

<ContextMenuRegion context={target} items={items} label="对象操作">
  <button type="button">{target.title}</button>
</ContextMenuRegion>;
```

## 配置与边界

- `items` 接受列表或 `(context) => items` 同步函数；菜单项支持动作、分隔线、分组、子菜单，以及图标、快捷键提示、显示和禁用条件。配置函数应无副作用。
- 菜单项 ID 在同一层级内唯一。`onSelect` 可返回 Promise；执行期间同一动作禁用，菜单关闭不取消已执行动作。
- `context` 在打开时固定，配置与回调在执行前重新读取。调用方保持上下文不可变，并在回调中检查对象是否仍有效。
- `children` 必须是单个 DOM 元素或能转发 DOM 属性与 ref 的自定义组件；通过 Base UI 的 `render` 组合复用原元素，组件不额外生成布局容器。
- 文本输入默认使用原生菜单。显式的 `mode="custom"` 可在输入元素及区域内的可编辑后代上接入自定义菜单；`mode="native"` 保留原生行为并隔离外层菜单。嵌套区域仍使用自己的菜单策略。空配置和 `disabled` 同样不会触发外层菜单。
- `density` 默认读取触发区域的密度并传给浮层。主题使用共享变量；快捷键提示只负责展示，实际快捷键由调用方注册。
- 跳转、打开对话框或自行移动焦点的动作设置 `restoreFocus: false`；普通动作关闭后恢复触发区域。可用 `fallbackFocus` 提供区域消失后的替代入口。
- 业务回调负责已有错误与重试流程；未处理的异常交给 `onActionError`，没有配置时显示公共失败提示。
- 页面、项目或模态状态切换时调用 `useContextMenus().closeAll()`。公共层自动处理区域卸载、窗口失焦、尺寸变化、外部点击及触发区域滚动。

## 验证

`pnpm test` 检查菜单过滤、配置条件、执行前校验及窗口协调；开发页面 `/tests/fixtures/context-menu.html` 提供无业务依赖的交互检查、主题、密度、长菜单、子菜单、原生输入和对话框复用验证。`/tests/fixtures/project-index.html` 使用内存 IPC mock 检查业务接入，不修改实际文件。

# Context Menu 插件

插件在 UI 根包装层安装菜单运行环境，并通过 `@lodestory/sdk/context-menu` 提供 `contextMenuKey`。跨插件消费者声明 `requires: [contextMenuKey]`，再从服务取得 `Region` 来包裹支持右键菜单的元素；菜单项和区域属性类型也从该 SDK 入口导入。

```tsx
import type { Plugin } from "@lodestory/sdk";
import { contextMenuKey, type MenuEntry } from "@lodestory/sdk/context-menu";

const projectActions: readonly MenuEntry<string>[] = [
  { id: "open", label: "打开", onSelect: (projectId) => openProject(projectId) },
];

export const projectPlugin: Plugin = {
  id: "example.project",
  requires: [contextMenuKey],
  provides: [],
  activate(context) {
    const { Region } = context.get(contextMenuKey);
    // 在 React 组件中使用：<Region context={projectId} items={projectActions}>…</Region>
  },
};
```

现有内置插件仍可从 `src/plugins/context-menu` 导入组件；该路径为应用内部兼容入口。新的跨插件接入应通过 SDK 能力，以便 EngineCore 检查依赖并在停用时撤销服务。
