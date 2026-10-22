# @lodestory/ui

Lodestory 自有 React 基础组件库。组件、公开属性类型和组件样式集中在此模块，应用及插件从包入口导入。

## 当前组件

| 组件 | 用途 | 主要属性 |
| --- | --- | --- |
| `Button` | 普通按钮 | `variant`: `primary` / `secondary` / `ghost` / `danger`，默认 `secondary` |
| `IconButton` | 图标按钮 | 必填 `label`，同时提供无障碍名称和悬停提示 |
| `Icon` | 装饰性 SVG 图标 | `name`，`size`: `default` / `small` / `medium` / `large` / `brand` |
| `SearchField` | 带图标的搜索输入框 | 必填 `label`，默认也用作 `placeholder` |

按钮默认 `type="button"`，表单提交时显式指定 `type="submit"`。按钮与搜索框支持原生属性及事件，通过公开类型约束，不开放任意 `className` / `style`，视觉差异优先扩展语义明确的变体。`Icon` 标记为装饰内容，操作的文字含义由外层按钮或标签提供。

## 接入

```tsx
import { Button, Icon, IconButton, SearchField } from "@lodestory/ui";

export function Example() {
  return <>
    <Button variant="primary"><Icon name="plus" />新建</Button>
    <IconButton label="关闭"><Icon name="close" /></IconButton>
    <SearchField label="搜索作品" />
  </>;
}
```

样式通过公开子入口一次性载入：

```css
@import "@lodestory/ui/styles.css";
```

Lodestory 已在 `src/styles.css` 接入该入口，插件无需重复导入。组件继承现有 `--ui-*` 配色、排版、尺寸和密度变量；库不写入主题、不读取主题存储，也不重复提供默认色值。单独预览或其他宿主使用时，须由宿主提供符合[主题标准](../../文档/主题标准-v1.md)和 [UI 设计规范](../../文档/UI设计规范.md)的变量；当前应用的基础尺寸变量位于 `src/styles/tokens.css`，配色由主题插件提供。缺少这些变量时不保证视觉正确。

组件 CSS 包含自身尺寸计算、字体继承、交互状态与强制颜色模式规则，不导入应用全局样式。配色不做过渡动画，主题变化时前景、背景和边界同步替换，也符合减少动效设置。页面负责外部布局和宽度，组件负责内部结构与状态；例如搜索框默认占父容器宽度，欢迎页另行设置工具栏搜索区的宽度。

## 主题与交互状态

所有颜色直接消费[颜色登记表](../../src/plugins/theme/color-registry.json)的角色，不按主题 ID、明暗类型分支，不保存第二套配色。主题插件在根元素更新变量，已挂载组件随之更新，无需重新挂载或重置输入值。宿主不得再给组件叠加状态颜色，否则会绕过本包的成套配色和优先级。

| 场景 | 取色规则 |
| --- | --- |
| 主操作 / 危险操作 | 各自 `action.*` / `danger.*` 的前景与默认、悬停、按下背景 |
| 普通悬停 / 按下 | `state.hover*` / `state.pressed*` 前景背景一起变化 |
| 选中 / 选中悬停 / 选中按下 / 失焦选中 | 对应 `state.selected*` / `state.inactiveSelected*` 组合，另绘制 `accent.indicator` 边界标记 |
| 禁用 / 禁用选中 | 对应 `state.disabled*` / `state.disabledSelected*`，边界为 `state.disabledBorder`；禁用选中保留标记 |
| 焦点 | `focus.ring` 独立外环，与填充间隔由共享 `--ui-focus-offset` 提供；不覆盖选中标记或错误边界 |
| 搜索框校验错误 | `aria-invalid` 为 `true`、`grammar`、`spelling` 时使用 `status.dangerBorder`；禁用时抑制错误边界 |
| 输入与文字选区 | 普通输入光标使用 `caret.foreground`；交互背景上的光标使用该状态前景；选区同时使用 `selection.foreground/background` |

按钮通过原生 `aria-pressed`（包括 `mixed`）或适用角色下的 `aria-selected` 表达选中；混合选中额外用虚线标记。选择状态仍由使用方拥有。`selectionActive={false}` 表示所属选择上下文失焦，不等同于按钮自身没有键盘焦点。优先级为：禁用选中 → 禁用 → 选中按下 → 选中悬停 → 失焦选中 → 选中 → 操作用途的按下、悬停、默认态。

禁用操作使用原生 `disabled`，也支持父级 `fieldset disabled`；`aria-disabled` 只声明语义和配色，保留可聚焦行为，使用方须拦截操作。只读搜索框保留普通配色、焦点与文字选择，不采用禁用配色。

控件实际放在反色表面（`surface.inverse`）上时，设置 `focusSurface="inverse"`，外环使用 `focus.inverseRing`；透明的 ghost / IconButton 默认前景也采用 `text.inverse`。其他控件仍绘制自己的成套填充。该属性描述控件**外侧表面**，不能根据按钮自己的填充色或主题明暗猜测。

`Icon` 使用 `currentColor`，由承载它的按钮、选中对象或内容区域提供最终前景。单独使用图标时也须由宿主提供与背景配套的前景。

## 职责边界

- 本包是无业务状态的展示组件模块，不是运行时插件，不建立全局单例，也不新增能力 key。React 组件的挂载和卸载决定其生命周期。
- 业务状态和保存流程仍由所属插件拥有；页面、布局贡献继续通过 SDK 的公开能力登记。组件库不导入 `src/`、Tauri、插件私有实现或 SDK 服务。
- `@lodestory/sdk` 只维护跨插件契约，`@lodestory/ui` 维护可复用的 UI 实现，两者职责分开。
- `PageShell`、`ProjectPageLayout`、文件树、文档标签栏和编辑器属于应用或业务布局，不纳入本包。右键菜单仍由现有插件负责根包装和协调；通用弹窗、输入框、下拉选择尚未迁入。
- 后续新增组件放在 `src/`，在 `src/index.ts` 导出组件和属性类型，并把组件样式放入 `styles.css`。复杂交互可在包内封装 Base UI，消费者不应依赖其内部实例。
- React 是 peer dependency，宿主和插件必须共享同一运行时；独立打包消费者时将 `react`、`react/jsx-runtime` 和本包作为外部依赖。

## 开发与验证

```sh
pnpm build:ui
pnpm dev:ui
```

仓库的 `pnpm dev` 自动构建并监听本包与 SDK；`pnpm build`、`pnpm test` 会先构建这些工作区包。JavaScript 与类型声明输出到 `dist/`，CSS 使用包根的 `styles.css`，因此修改 CSS 不需另做复制步骤。

本包可通过 `pnpm --dir packages/ui pack` 生成包含 JavaScript、类型和样式的归档；当前只在本地工作区接入，未发布到包仓库。

`tests/fixtures/ui-theme.html` 是开发验收页，通过真实主题插件切换内置深浅主题及两套同类型的自定义测试配色，检查四个组件、状态叠加和输入内容保留。测试配色用于区分角色，不作为正式主题发布。`tests/ui-library.test.mjs` 核验导出、类型和登记变量；`tests/ui-theme-browser.test.mjs` 在安装 Playwright 与 Chromium 后验证真实计算样式及交互。
