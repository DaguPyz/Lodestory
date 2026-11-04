# Shortcuts 插件

Shortcuts 插件只负责登记操作、解析按键和调用操作所属插件。项目数据、保存、搜索、文件树选择和文档关闭流程仍由原插件拥有。插件通过 SDK 的 `shortcutsKey` 提供 `ShortcutsService`；消费者在 `requires` 声明同一个 key。

## 登记操作与按键

业务插件在 `activate` 中登记稳定 ID、名称、类别、可执行条件和回调，并声明默认按键。每次登记返回幂等撤销函数，插件停用时调用。

```ts
import {shortcutsKey, shortcutScopeIds} from "@lodestory/sdk/shortcuts";

const shortcuts = context.get(shortcutsKey);
const removeCommand = shortcuts.registerCommand({
  id: "example.refresh",
  title: "刷新",
  category: "项目",
  enabled: () => isReady(),
  run: () => refresh(),
});
const removeBinding = shortcuts.registerBinding({
  id: "example.refresh.default",
  commandId: "example.refresh",
  scopeId: shortcutScopeIds.workbench,
  keys: "Mod+R",
});

// 在插件 deactivate 时：
removeBinding();
removeCommand();
```

界面按钮通过 `execute(commandId, args?)` 调用相同操作；重新检查 `enabled`，操作进行期间拒绝重复调用。`getSnapshot()` 与 `subscribe()` 用于显示登记状态，`getShortcut(commandId)` 返回平台格式化提示。执行失败会通过 Promise 拒绝；键盘触发处负责记录失败。

默认作用域树如下。只有按键目标命中、该作用域及所有祖先都处于活动状态时，绑定才可执行；更深的作用域先匹配。同一最深作用域内的冲突不会按登记顺序选择操作，也不会显示成有效提示。

```text
application
└─ workbench
   ├─ document
   └─ project-tree
```

`ShortcutScope.active()` 由登记它的插件根据自己拥有的状态实现；`contains(target)` 可把作用域限制到具体 DOM 区域。父作用域未登记或停用时，后代绑定不生效。撤销父作用域会让已登记后代暂时失效，后代仍由各自插件撤销。

## 按键处理规则

- 支持单个组合键；`Mod` 在 macOS 表示 Command，在 Windows/Linux 表示 Ctrl。修饰键需精确匹配；允许无修饰键的 `F1`–`F24`。不支持多段序列或系统级全局热键。
- 监听器在 UI 根包装中只安装一次，并于插件停用时撤销。它在 document 冒泡阶段读取按键，因此被编辑器或组件消费、且设为 `defaultPrevented` 的事件不会二次执行。
- 输入法组合、AltGraph、浏览器或组件已处理的按键不会触发。输入框中的绑定默认停用；只有显式设置 `allowInInput: true` 才能生效。按键重复时阻止浏览器重复默认动作，但不重复执行命令。
- 按键发生时通过 UI 服务的 `hasActiveOverlay()` 查询当前窗口。有可交互的浮层时，暂停背景快捷键；最后一层关闭后恢复。
- 失焦、隐藏页面和不活动作用域不触发快捷键。运行时遇到同作用域冲突时不执行任一命令。

## 用户绑定与配置

快捷键插件内部登记 `shortcuts.bindings` 配置项，依赖既有 `configKey` 持久化覆盖；这不是独立的 SDK 配置契约。业务插件不注册此配置项，也不直接修改 ConfigService 中的快捷键数据。其他插件通过 `setBinding(bindingId, keys)` 改绑，通过 `setBinding(bindingId, null)` 清除默认绑定，通过 `resetBinding(bindingId)` 恢复默认值。

改绑先验证组合键和当前同作用域冲突，再保存配置；冲突以 SDK 的 `ShortcutConflictError` 返回涉及的绑定 ID，保存失败会拒绝 Promise 并保持旧绑定。快照包含默认按键、显示文本及是否有用户覆盖。恢复默认值也按相同的保存顺序执行。未激活插件的配置项会保留，以便下次登记时恢复；配置只存当前应用，不随项目切换。

快捷键插件通过 `settingsKey.registerSection` 向设置弹框贡献“操作 → 快捷键”。界面读取公开快照，支持搜索、按键录入、清除和恢复默认；冲突不覆盖已有绑定，保存失败后可重试。编辑器内部快捷键仍由编辑器处理。设置分类在插件停用前撤销；已接收的按键变更完成后，插件才注销配置和释放服务。

## 第一阶段默认操作

| 操作 | 默认键 | 作用域 |
| --- | --- | --- |
| 保存全部文稿 | `Mod+S` | 工作台；允许在输入框中触发 |
| 搜索项目资源 | `Mod+Shift+F` | 工作台；允许在输入框中触发 |
| 新建文档 | `Mod+N` | 工作台；允许在输入框中触发 |
| 关闭当前文稿 | `Mod+W` | 当前文稿；允许在输入框中触发 |
| 重命名文件或文件夹 | `F2` | 工程树获得焦点时 |

编辑器的正文编辑、查找和撤销仍由编辑器实现处理；弹框拖动、菜单导航与 Select 导航仍由对应 UI 组件处理。按钮和工具提示读取快捷键服务里的实际绑定。

## 验收

```sh
node --test tests/shortcuts.test.mjs
pnpm exec tsc --noEmit
```

单元测试覆盖 Mod 平台映射、父子作用域、冲突、IME 与重复输入、禁用和并发执行、改绑保存失败回滚、ConfigService 集成及插件卸载清理。应用验证还需检查弹框／菜单／Select 打开时不触发背景动作，并在切换项目、切换面板和停用插件后确认旧绑定失效。
