# @lodestory/ui

Lodestory 自有 React 基础组件库。组件、公开属性类型和组件样式集中在此模块，应用及插件从包入口导入。

## 当前组件

| 组件 | 用途 | 主要属性 |
| --- | --- | --- |
| `Button` | 普通按钮 | `variant`: `primary` / `secondary` / `ghost` / `danger`，默认 `secondary` |
| `IconButton` | 图标按钮 | 必填 `label`，同时提供无障碍名称和悬停提示 |
| `Icon` | 装饰性 SVG 图标 | `name`，`size`: `default` / `small` / `medium` / `large` / `brand` |
| `SearchField` | 带图标的搜索输入框 | 必填 `label`，默认也用作 `placeholder` |
| `TextField` | 单行文本或数字输入 | 原生输入属性与 `ref`；`type` 限定为文本类和数字类，默认 `text` |
| `Textarea` | 多行文本输入 | 原生多行输入属性与 `ref`；默认 `rows=3`，支持显式覆盖 |
| `Select` | 受控单选下拉框 | `value`、`options`、`onValueChange`；`variant`: `field`（默认）/ `title` / `toolbar`；支持占位、禁用、只读、表单属性、颜色样本及 `triggerIcon` / `iconOnly` 图标触发器 |
| `Dialog` | 受控模态弹框 | `open`、`onOpenChange`、`title`，可选 `onOpenChangeComplete`、`size`（`regular` 默认、`narrow`、`wide`、`large`）、`description`、`busy`、`initialFocus`、`finalFocus` |
| `DialogActions` | 弹框操作区 | 统一右对齐、间距与换行 |
| `DialogClose` | 关闭弹框的按钮 | 支持 `Button` 属性和 `ref`，固定为非提交按钮 |

按钮默认 `type="button"`，表单提交时显式指定 `type="submit"`。按钮、搜索框和文本输入支持原生属性及事件，通过公开类型约束，不开放任意 `className` / `style`，视觉差异优先扩展语义明确的变体。`TextField` 不能用于 checkbox、radio、按钮等非文本输入；`type="number"` 保留原生 `min`、`max`、`step` 属性。`Icon` 标记为装饰内容，操作的文字含义由外层按钮或标签提供。

## 接入

```tsx
import { Button, Icon, IconButton, SearchField, TextField, Textarea } from "@lodestory/ui";

export function Example() {
  return <>
    <Button variant="primary"><Icon name="plus" />新建</Button>
    <IconButton label="关闭"><Icon name="close" /></IconButton>
    <SearchField label="搜索作品" />
    <TextField name="chapterCount" type="number" min={1} step="1" />
    <Textarea name="summary" placeholder="补充说明" />
  </>;
}
```

样式通过公开子入口一次性载入：

```css
@import "@lodestory/ui/styles.css";
```

Lodestory 已在 `src/styles.css` 接入该入口，插件无需重复导入。组件继承现有 `--ui-*` 配色、排版、尺寸和密度变量；库不写入主题、不读取主题存储，也不重复提供默认色值。单独预览或其他宿主使用时，须由宿主提供符合[主题标准](../../文档/主题标准-v1.md)和 [UI 设计规范](../../UI规范/UI设计规范.md)的变量；当前应用的基础尺寸变量位于 `src/styles/tokens.css`，配色由主题插件提供。缺少这些变量时不保证视觉正确。

组件 CSS 包含自身尺寸计算、字体继承、交互状态与强制颜色模式规则，不导入应用全局样式。同一主题内允许的表面反馈和浮层显隐过渡为 150ms；换主题时前景、背景和边界同步替换。页面负责外部布局，组件负责控件宽度、边界和内部状态；例如搜索框、TextField、Textarea 默认占父容器宽度，欢迎页另行设置工具栏搜索区的宽度。

## 主题与交互状态

所有颜色直接消费[颜色登记表](../../src/plugins/theme/color-registry.json)的角色，不按主题 ID、明暗类型分支，不保存第二套配色。主题插件在根元素更新变量，已挂载组件随之更新，无需重新挂载或重置输入值。宿主不得再给组件叠加状态颜色，否则会绕过本包的成套配色和优先级。

| 场景 | 取色规则 |
| --- | --- |
| 主操作 / 危险操作 | 各自 `action.*` / `danger.*` 的前景与默认、悬停、按下背景 |
| 普通悬停 / 按下 | `state.hover*` / `state.pressed*` 前景背景一起变化 |
| 选中 / 选中悬停 / 选中按下 / 失焦选中 | 对应 `state.selected*` / `state.inactiveSelected*` 组合；选中态通过前景与背景颜色区分，不叠加勾号；混合态可用短横表示；IconButton 保持图标居中 |
| 禁用 / 禁用选中 | 对应 `state.disabled*` / `state.disabledSelected*`，边界为 `state.disabledBorder`；禁用选中态不叠加勾号，IconButton 保持图标居中 |
| 焦点 | 有边框的输入控件在原边界内侧绘制 2px 焦点线，与边框合并且不改变尺寸；按钮和无边框控件使用独立外环，与填充间隔由共享 `--ui-focus-offset` 提供 |
| 搜索框校验错误 | `aria-invalid` 为 `true`、`grammar`、`spelling` 时使用 `status.dangerBorder`；聚焦时仍以该色显示一条 2px 边界，禁用时抑制错误边界与焦点提示 |
| 输入与文字选区 | 普通输入光标使用 `caret.foreground`；交互背景上的光标使用该状态前景；选区同时使用 `selection.foreground/background` |

按钮通过原生 `aria-pressed`（包括 `mixed`）或适用角色下的 `aria-selected` 表达选中；文本 Button 仅对 `aria-pressed` 预留固定混合态标记槽，避免状态切换改变控件尺寸。普通选中态不显示勾号；混合态显示短横并继承对应状态前景色。IconButton 只呈现同态前景与中性选中背景，不额外显示标记或预留边距。Select 下拉项同样只用选中前景和背景颜色区分。选择状态仍由使用方拥有。`selectionActive={false}` 表示所属选择上下文失焦，不等同于按钮自身没有键盘焦点。优先级为：禁用选中 → 禁用 → 选中按下 → 选中悬停 → 失焦选中 → 选中 → 操作用途的按下、悬停、默认态。

TextField、Textarea、SearchField 和 `variant="field"` 的 Select 常态及悬停／按下／展开时都保持 `border.default`。只读字段维持常态边界，仍可聚焦与选择文字；`variant="title"`、`variant="toolbar"` 的 Select 保持无边框语义。常规悬停只改变表面与同态前景，不改变边框或阴影。文本输入控件聚焦时，在原边界内侧显示 2px 焦点线，与原边框合成一条，不留外侧间距、不改变尺寸；该焦点线邻接字段自身中性填充，使用 `focus.ring`。SearchField 由外层边界承载焦点，内部输入框不重复绘制。无效且聚焦时保留 `status.dangerBorder`，用加粗的同一条边界表示焦点，并保留错误文字或图标；禁用控件不显示焦点。按钮和无边框控件沿用独立外侧焦点环；此类焦点环按 `focusSurface` 描述的外侧邻接表面选择角色。高对比模式使用系统焦点色；强制色模式下，无效边界可以用虚线保留错误差异。

禁用操作使用原生 `disabled`，也支持父级 `fieldset disabled`；`aria-disabled` 只声明语义和配色，保留可聚焦行为，使用方须拦截操作。只读搜索框保留普通配色、焦点与文字选择，不采用禁用配色。

控件实际放在反色表面（`surface.inverse`）上时，设置 `focusSurface="inverse"`，独立外环使用 `focus.inverseRing`；透明的 ghost / IconButton 默认前景也采用 `text.inverse`。表单字段的内侧焦点线邻接字段自己的中性填充，因此使用 `focus.ring`，不因 `focusSurface` 改色。该属性描述控件**外侧表面**，不能根据按钮自己的填充色或主题明暗猜测。

`Icon` 使用 `currentColor`，由承载它的按钮、选中对象或内容区域提供最终前景。单独使用图标时也须由宿主提供与背景配套的前景。

`IconButton` 的 `label` 是简短无障碍名称；可通过 `tooltip` 补充当前快捷键等悬停提示，不修改按钮的可访问名称。未提供时沿用 `label`。

组件库可通过 `InteractionProvider` 接收可选的 `onActivate` 回调。Dialog、Select 在浮层可交互时通知该回调，并在关闭、禁用或卸载时调用回调返回的清理函数。独立实现的浮层可使用 `useInteractionRef` 接入同一通知协议。不提供 Provider 时组件仍可独立使用。组件库不管理应用级浮层状态。

Dialog 的 `bodyLayout="fill"` 用于需要自行管理内部滚动的内容；默认仍由 Dialog 正文滚动。弹框的标题、焦点和拖动行为保持一致。

## 通用弹框

```tsx
import { Button, Dialog, DialogActions, DialogClose } from "@lodestory/ui";

<Dialog open={open} onOpenChange={setOpen} title="新建文档"
  description="为文档取个名字。" busy={busy} initialFocus={nameInput}>
  <form onSubmit={handleSubmit}>
    {/* 表单字段、校验、提交和错误提示由插件提供。 */}
    <DialogActions>
      <DialogClose>取消</DialogClose>
      <Button type="submit" variant="primary" disabled={busy}>创建</Button>
    </DialogActions>
  </form>
</Dialog>
```

`Dialog` 在包内封装 Base UI，统一遮罩、标题与描述的无障碍关联、焦点限制和关闭后焦点恢复。默认允许 Escape、点击遮罩及 `DialogClose` 请求关闭；`busy` 时拦截这些关闭请求并禁用关闭按钮。关闭请求立即更新业务 `open` 状态；Popup 随后短暂 inert 并按时长退出，`onOpenChangeComplete(false)` 在 Base UI 完成退出后通知 UI 宿主。回调只用于释放过渡期间保留的呈现快照，不能延迟业务关闭、导航或保存结果。失败时保留业务表单和输入内容。

`initialFocus` 指定打开后的焦点，删除确认可指向取消按钮；`finalFocus` 可显式指定关闭后接收焦点的元素，不传时由 Base UI 恢复原焦点。弹框通过 Portal 挂到文档中，打开时从当前焦点读取最近的 `data-ui-density` 容器，并把密度带到 Portal；找不到有效触发密度时回退到 `comfortable`。因此欢迎页等 `spacious` 区域的弹框保留宽松密度，主题仍从应用根继承。

弹框使用 `surface.floating`、`text.primary/secondary`、`border.divider`、`overlay.scrim`、`focus.ring` 与轻浮层阴影；标题、尺寸、间距也沿用项目标准。长描述自动换行，高度超出视口时内部滚动，切换主题不重新挂载业务内容。

宽度预设依次消费 `--ui-dialog-width-narrow`（480px）、`--ui-dialog-width`（560px）、`--ui-dialog-width-wide`（640px）和 `--ui-dialog-width-large`（800px）；任何预设仍受视口安全边距约束。组件默认使用 `regular`，旧调用无需增加属性。宽度是语义选项，Base UI 实例和定位细节不属于公共 API。

每次打开时 Dialog 默认在视口内居中；标题栏可用鼠标或触控直接拖动，也可聚焦标题栏后用方向键移动 8px、按住 Shift 移动 24px，Home 或双击标题栏回到居中位置。弹框与视口边缘保持至少 16px；窗口变化或打开期间内容尺寸变化时保留当前位置，只在越界时修正，不因内容更新重新居中。标题栏固定不随正文滚动，正文区域独立滚动。拖动期间按 Escape 会撤销本次移动并保持弹框打开；未拖动时 Escape 仍按正常规则请求关闭。位置仅属于当前打开的组件实例，不持久化；关闭或卸载时清理观察器、监听和待执行帧回调。

弹框、遮罩与 Select 的开合动画仅在透明度上过渡 150ms，不移动或缩放；用户直接拖动时位置即时跟随，不做缓动。初次已打开的弹框也会淡入。关闭、选值和焦点管理仍由 Base UI 生命周期完成，CSS 过渡不会延迟业务回调；连续开合会按最新状态中断过渡。

时长与位移读取宿主共享的 `--ui-duration-fast`、`--ui-duration-normal`、`--ui-duration-dialog` 和 `--ui-motion-offset`；系统减少动效媒体偏好与根元素 `data-ui-motion="reduce"` 由宿主设置为 0ms／0px。焦点环保持即时。主题色不做插值，切换主题时前景、背景与边界同步替换。

## 单选下拉框

```tsx
import { Select } from "@lodestory/ui";

<label htmlFor="document-parent">保存位置</label>
<Select id="document-parent" name="documentParent"
  value={parentPath} onValueChange={setParentPath} disabled={busy}
  options={[{ value: "", label: projectName }, ...folderOptions]} />
```

选项类型为 `{ value: string, label: string, disabled?: boolean, swatch?: string }`，值必须唯一。`null` 表示未选择，显示 `placeholder`；空字符串是合法选项，用于根目录、默认字体等。`onValueChange` 只回传用户选择的字符串，选项数据和状态更新仍归使用方。若当前值暂时不在选项中，组件保留该值，不擅自选择其他项；插件可以提供带说明的禁用选项表示不可用值。

Base UI 在包内负责列表定位、键盘导航、按字符查找、Escape 关闭和焦点恢复。展开面板通过 Portal 避免被表单或编辑器裁切，复制触发器所属的 `data-ui-density`，颜色始终继承根元素主题变量。长选项自动换行，长列表内部滚动；触发器宽度由外层容器决定。面板在碰撞定位后的最终位置以 150ms 淡入淡出；减少动效时直接到达终态。选项高度使用菜单密度变量，区别于触发器的控件高度。组件不开放 `className` / `style`，宿主不应覆盖其状态颜色。

`disabled` 阻止交互并收起已打开的面板；单个选项的 `disabled` 阻止选值，但仍可被键盘聚焦以获知内容。`readOnly` 允许展开查看，阻止更改。选中、悬停、按下、禁用及其组合均使用项目成套前景／背景角色，对应变体的焦点线独立于选中背景；`aria-invalid` 提供错误边界，禁用时使用禁用边界。通过关联的 `<label>` 或 `aria-label` / `aria-labelledby` 提供名称。

`name` / `form` 支持原生 FormData 提交；`required` 与原生控件一样将空字符串视为缺值，根目录若是有效业务值则不要将该字段声明为必填。`ref` 指向触发按钮；`onOpenChange` 用于观察展开状态；`finalFocus` 可指定关闭后接收焦点的元素，编辑器可指向正文。`swatch` 只展示业务内容的颜色样本（例如文字颜色），不改变控件的主题配色。

`variant="field"` 是默认形式，用于表单字段和系统主题映射，保留常规控件表面与边界。`variant="title"` 用于布局标题栏中的导航内容切换：触发器采用 Strong 字号和字重（16 / 24px、600）、常态透明、按文字与箭头收宽。`variant="toolbar"` 用于编辑工具栏：常态透明，并继承所在区域的密度；编辑器将工具栏设为 `compact`。具体排列由所属工具界面决定，Select 继续管理内部尺寸与状态，消费者不覆盖触发器样式。三种形式均沿用共享的悬停、按下、展开、焦点和禁用状态，并共用菜单、键盘和无障碍行为。

工具栏 Select 可提供 `triggerIcon` 和 `iconOnly`：图标只替代触发器的可见选值，当前选值仍留在辅助技术可读文本中。`iconOnly` 必须配合 `triggerIcon`，调用方为每个控件提供 `aria-label`；可将动态选值放入 `title`，让悬停提示显示当前格式。Compact 下图标触发器为 32 × 32px，与动作按钮同高。颜色选项的 `swatch` 作为图标下缘细色条显示作者所选颜色，不参与主题控件着色。

```tsx
import { Icon, Select } from "@lodestory/ui";

<Select variant="toolbar" iconOnly triggerIcon={<Icon name="textColor" />}
  aria-label="文字颜色" title={`文字颜色：${selectedColorLabel}`}
  value={color} options={colors} onValueChange={setColor} />
```

```tsx
<Select variant="title" aria-label="切换导航内容"
  value={activeContentId} onValueChange={setActiveContentId} options={contents} />
```

保存位置和系统主题映射使用默认的 `field` 形式。工具栏可使用 `compact` 密度和 32 × 32px 的 `toolbar` 图标触发器，控件支持键盘访问。使用公开属性调整 Select 的外观。

## 职责边界

- 本包是无业务状态的展示组件模块，不是运行时插件，不建立全局单例，也不新增能力 key。React 组件的挂载和卸载决定其生命周期。
- 业务状态和保存流程仍由所属插件拥有；页面、布局贡献继续通过 SDK 的公开能力登记。组件库不导入 `src/`、Tauri、插件私有实现或 SDK 服务。
- `@lodestory/sdk` 只维护跨插件契约，`@lodestory/ui` 维护可复用的 UI 实现，两者职责分开。
- `PageShell`、`.app-shell` 和 `.window-titlebar` 属于独立的 `window-shell` 插件，不纳入本包；应用导航布局和专属样式由 `navigation-layout` 插件管理。公共样式继续留在 `src/styles.css`，由 `navigation-layout` 和 `workbench` 显式导入。文件树、文档标签栏和编辑器也属于应用或业务布局，不纳入本包。右键菜单仍由现有插件负责根包装和协调；应用表单的文本与数字字段通过共享 TextField / Textarea 接入，正文编辑器不属于这些控件。新建项目、新建文档／文件夹和删除文档复用通用弹框，业务逻辑仍在原插件内。
- 后续新增组件放在 `src/`，在 `src/index.ts` 导出组件和属性类型，并把组件样式放入 `styles.css`。复杂交互可在包内封装 Base UI，消费者不应依赖其内部实例。
- React 与 React DOM 是 peer dependencies，宿主和插件必须共享同一运行时；独立打包消费者时将 `react`、`react/jsx-runtime`、`react-dom` 和本包作为外部依赖。Base UI 是包内实现依赖，不通过公共属性暴露其类型。

## 开发与验证

```sh
pnpm build:ui
pnpm dev:ui
```

仓库的 `pnpm dev` 自动构建并监听本包与 SDK；`pnpm build`、`pnpm test` 会先构建这些工作区包。JavaScript 与类型声明输出到 `dist/`，CSS 使用包根的 `styles.css`，因此修改 CSS 不需另做复制步骤。

本包可通过 `pnpm --dir packages/ui pack` 生成包含 JavaScript、类型和样式的归档；当前只在本地工作区接入，未发布到包仓库。

`tests/fixtures/ui-theme.html` 是开发验收页，通过真实主题插件切换内置深浅主题及两套同类型的自定义测试配色，检查四个组件、状态叠加和输入内容保留。测试配色用于区分角色，不作为正式主题发布。`tests/ui-library.test.mjs` 核验导出、类型和登记变量；`tests/ui-theme-browser.test.mjs` 在安装 Playwright 与 Chromium 后验证真实计算样式及交互。

`tests/fixtures/ui-dialog.html` 检查独立弹框与迁移后的三个业务弹框，支持主题切换、模拟提交成功／失败、处理中关闭保护、长路径换行和键盘焦点验收；文件操作均由回调模拟。`tests/ui-dialog.test.mjs` 覆盖忙碌时取消关闭请求、关闭按钮的禁用／ref／非提交行为和模态语义。

`tests/fixtures/ui-select.html` 检查 Select 的内置与同类型自定义主题、键盘、动态禁用、只读、空值、长列表、表单提交和弹框嵌套。Alt+T 在面板打开时切换主题，Alt+D 切换普通选择器的禁用状态。
