# Lodestory · UI 设计规范

**版本：4.1.1 ｜ 日期：2026-10-25 ｜ 方向：Notion 风格的安静文档工具 ｜ 状态：主题、共享控件与现有界面已同步；跨平台客户端验收待完成**

适用于全部自绘界面：应用外壳、插件页面、工作台、`@lodestory/ui`、编辑器周边工具、菜单、浮层与弹框。原生窗口和系统对话框遵循平台行为；作者文稿中的字体、颜色、图片属于内容，不因界面换肤而改写。

本版依据用户提供的 Notion 风格描述制定，以亮色为基准，重新设计对应深色。它是 Lodestory 的设计要求，不声称是 Notion 官方规范或其实际产品色值。**新设计要求覆盖旧规范中冲突的视觉与动效约定；现有主题变量契约和插件架构继续有效。** 本目录原有[浅色图](浅色.png)与[深色图](深色.png)属于旧版绿色方向，只保留作历史参考，不再作为本版视觉验收依据。

## 01. 设计方向与约束

### VIS-01｜内容优先，界面退后

白色承载正文，米白承载导航与辅助区，暖深灰承载文字。层级主要来自排版、留白和很小的表面明度差；蓝色用于必要主操作与链接。焦点使用低饱和灰蓝，选中统一中性灰底；选中项不附加对勾，纯图标保持居中。不要把整页染成蓝色，也不要沿用旧版绿色外壳。

工作台是连续的文档空间：停靠面板共享边界，内容分组优先使用标题和间距，真实独立对象才使用卡片。标题与内容易于扫描，常用操作位置稳定；辅助操作按需显现，不能挤动正文。

### VIS-02｜必须遵守

- 亮色使用 `#FFFFFF` 内容区、`#F7F6F3` 米白辅助区与 `#37352F` 主要文字。
- 普通悬停仅作低幅度背景变化：亮色 `#EFEDEA`，按下 `#E3E1DB`；选中统一使用中性灰底；文字选项、菜单和列表不附加对勾，混合态显示短横。纯图标控件保持主图标居中，不额外叠加对勾；不绘制彩色整圈或选中下划线。
- 常规命令按钮采用透明底色；少量明确主操作和危险确认保留现有 `primary`、`danger` 语义，使用本规范的克制实色配对。
- 使用系统字体、简洁单色线性图标、小圆角和稳定命中区。
- 普通状态颜色与浮层透明度过渡为 150ms；时间线事件文字悬停按 VIS-03 另用 500ms 联动放大；输入、焦点、选值与关键状态即时生效。
- 只有真实支持拖动／排序的条目显示拖拽手柄，悬停与键盘进入条目时显现，不改变排版；同时提供等效键盘或菜单操作。

### VIS-03｜禁止事项与冲突裁决

禁止渐变背景或文字、重阴影、玻璃态、装饰光晕、密集嵌套卡片、大面积鲜艳填色、单侧粗色条装饰、按钮上浮，以及悬停时改变边框或阴影。位移只用于时间线聚焦时关联资产节点的展开、收起及原位置附近的轻微漂浮，缩放规则见下文与 MOT-01。禁止 `transition: all`、弹跳／弹簧缓动和其他持续装饰动画。

时间线事件文字悬停以 500ms 同时放大：主标题从 1 倍至 1.2 倍，日期／时间偏移和摘要从 1 倍至 1.05 倍；主标题下的短横线同步以 `scaleX` 从 1 倍伸至 1.2 倍，线宽保持 1px。文字与短横线共用贝塞尔曲线 `cubic-bezier(.2, 0, 0, 1)`，同时开始；移出以相同时长平滑恢复。背景透明、文字颜色不变。按左右对齐固定文字组和短横线对应边缘；节点、布局占位与点击区域保持稳定，其他线条不变。仅在支持悬停且事件画布活跃时启用；系统或用户减少动效时取消缩放。此例外同时适用于亮暗与自定义主题，不扩展至其他控件或端点。

圆角上限为 8px，圆形头像、开关轨道、真实数据节点及平台窗口轮廓按其用途例外；普通按钮、标签和卡片不能做成胶囊。静态居中定位可以使用 transform，用户直接拖动时的位置更新可以即时跟手；两者都不构成允许位移过渡的理由。

参考稿中的 `active:scale-95`、`hover:shadow-md`、输入框 `transition-all` 以及装饰性拖拽手柄不采用。其通用大标题、Hero 和卡片网格只是网页示例，不要求工作台照搬。`border-gray-200` 只适合作装饰边线，不能替代识别空输入框所需的边界。低对比度亮蓝、亮红、黄色只作为调色起点，不能直接作小字或白字按钮背景。

## 02. 主题契约与插件接入

### GOV-01｜唯一来源

| 内容 | 编辑与消费方式 |
| --- | --- |
| 颜色角色、CSS 映射、配对与缺省规则 | [颜色登记表](../src/plugins/theme/color-registry.json)是唯一机器编辑源；契约说明见[主题标准 v1](../文档/主题标准-v1.md) |
| 本版亮暗设计目标 | 本文第 03 节；色值不得复制成页面私有配色 |
| 当前运行配色 | [浅色主题](../src/plugins/builtin-themes/light.theme.json)与[深色主题](../src/plugins/builtin-themes/dark.theme.json)；已采用本版完整配色 |
| 字体、尺寸、密度、圆角与时长 | [共享 tokens](../src/styles/tokens.css)；本文标明新目标及现有差异 |
| 公共组件与交互实现 | [@lodestory/ui](../packages/ui/README.md)，统一消费 `--ui-*` |
| 动效细则与生命周期 | [统一动效规范](动效规范.md)，与本版同步重订 |

后续变更编辑上述对应源，再运行现有生成脚本；不能手改生成的 `theme-colors.css`、SDK 颜色类型、Schema 或颜色角色登记文档。

### GOV-02｜归属、协作与生命周期

| 问题 | 本版约束 |
| --- | --- |
| 归属 | 主题插件管理配色与选择，内置主题插件贡献预设；UI 包拥有共享控件外观；布局及业务插件各自拥有呈现结构与业务状态 |
| 协作 | 沿用 `@lodestory/sdk/theme` 的 `themeKey`、`ThemeDefinition`、`ThemeService` 和登记过的颜色角色；不新增业务或组件专属颜色接口 |
| 接入 | 配色贡献者声明 `requires: [themeKey]`，经 `context.get(themeKey).registerTheme(...)` 登记；页面、根包装、布局内容和编辑器仍走其现有公开登记接口 |
| 生命周期 | 主题与偏好属于应用实例；贡献者保留撤销函数，监听与登记在退出或失败时清理；先停止 UI 使用服务，再释放服务；换肤不能重建编辑器、丢失输入或绕过保存失败保护 |
| 验收 | 相同组件只消费标准角色，替换主题无需改消费者；浮层、选区、焦点同步更新，项目会话与作者内容保留 |

`src/plugin-core/` 不识别主题、页面或编辑器业务，入口只装配。`@lodestory/ui` 是共享组件包，不变成业务运行时插件；插件不能导入其他插件的私有主题 store、编辑器实例或内部 Context。

### GOV-03｜主题选择与切换

保留当前 `lodestory.builtin.light`／`lodestory.builtin.dark` 身份；以亮色作为调色基准不等于更改默认选择。当前[配置](../src/plugins/theme/theme-config.json)默认选择内置深色，本次同步不改用户偏好。

主题按 ID 平级选择，`light`／`dark` 只是明暗属性；“跟随系统”分别选择两套已登记主题。根的 `data-ui-theme-id` 表达实际主题，`data-ui-theme` 与 `color-scheme` 表达明暗属性。组件不能按 ID 或明暗属性写死配色分支。

切换时所有颜色在同一更新批次替换，不跨主题插值；已展开的 Select、Menu、Tooltip、Dialog 和 Portal 同步更新。当前值、输入、选区、展开状态与焦点保留。密度只影响几何，不覆盖主题。

## 03. 亮色与对应深色

### COL-01｜配色原则与完整映射

本节是两套内置预设的**现行配色基线**，每个登记角色都明确给出亮暗值。自定义主题仍可使用其他色系，消费者必须按语义取色。左列是主题 JSON 的 `colors` key，中列是已有 CSS 变量；名字不一定一一同形，例如 `surface.content` 对应 `--ui-surface-workspace`，`border.strong` 对应 `--ui-border-control`。

全部颜色使用 sRGB `#RRGGBB`；仅遮罩和阴影使用登记允许的 `#RRGGBBAA`。相同色值不代表角色可以互换；焦点、选中、危险操作和成功状态继续拥有各自语义。

#### 中性表面（6）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `surface.root` | `--ui-surface-root` | `#F7F6F3` | `#191918` |
| `surface.content` | `--ui-surface-workspace` | `#FFFFFF` | `#20201E` |
| `surface.secondary` | `--ui-surface-panel` | `#F7F6F3` | `#1C1C1A` |
| `surface.tonal` | `--ui-surface-chrome` | `#F1F0ED` | `#252523` |
| `surface.control` | `--ui-surface-control` | `#FFFFFF` | `#252523` |
| `surface.floating` | `--ui-surface-overlay` | `#FFFFFF` | `#2C2C29` |

#### 文字（7）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `text.primary` | `--ui-text-primary` | `#37352F` | `#F1F0EB` |
| `text.secondary` | `--ui-text-secondary` | `#5D5A53` | `#C6C4BC` |
| `text.muted` | `--ui-text-muted` | `#6B6860` | `#AAA8A0` |
| `text.placeholder` | `--ui-text-placeholder` | `#6B6860` | `#AAA8A0` |
| `text.disabled` | `--ui-text-disabled` | `#77746D` | `#89877F` |
| `text.reading` | `--ui-text-document` | `#37352F` | `#E7E5DE` |
| `text.onAction` | `--ui-text-on-action` | `#FFFFFF` | `#FFFFFF` |

#### 边界（4）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `border.divider` | `--ui-border-divider` | `#E7E5DF` | `#373734` |
| `border.decoration` | `--ui-border-decoration` | `#D7D4CC` | `#4A4A45` |
| `border.default` | `--ui-border-default` | `#807C74` | `#929087` |
| `border.strong` | `--ui-border-control` | `#625F58` | `#B4B2AA` |

#### 强调、焦点、光标与选区（6）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `accent.foreground` | `--ui-accent-foreground` | `#176985` | `#8CCFE2` |
| `accent.indicator` | `--ui-accent-indicator` | `#145F79` | `#86CDE2` |
| `focus.ring` | `--ui-focus-ring` | `#5A6C7B` | `#95A5B2` |
| `caret.foreground` | `--ui-caret-foreground` | `#37352F` | `#F1F0EB` |
| `selection.background` | `--ui-text-selection-bg` | `#D8EAF0` | `#234454` |
| `selection.foreground` | `--ui-selection-foreground` | `#174B5B` | `#EAF7FA` |

#### 通用交互状态（17）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `state.hoverBackground` | `--ui-surface-hover` | `#EFEDEA` | `#2F2F2C` |
| `state.hoverForeground` | `--ui-state-hover-foreground` | `#37352F` | `#F1F0EB` |
| `state.pressedBackground` | `--ui-surface-pressed` | `#E3E1DB` | `#3A3A35` |
| `state.pressedForeground` | `--ui-state-pressed-foreground` | `#37352F` | `#F1F0EB` |
| `state.selectedBackground` | `--ui-surface-selected` | `#E3E1DB` | `#3A3A35` |
| `state.selectedForeground` | `--ui-state-selected-foreground` | `#37352F` | `#F1F0EB` |
| `state.selectedHoverBackground` | `--ui-surface-selected-hover` | `#D9D7D0` | `#42423C` |
| `state.selectedHoverForeground` | `--ui-state-selected-hover-foreground` | `#37352F` | `#F5F3ED` |
| `state.selectedPressedBackground` | `--ui-state-selected-pressed-background` | `#CFCDC5` | `#4A4A43` |
| `state.selectedPressedForeground` | `--ui-state-selected-pressed-foreground` | `#2D2B26` | `#FFFFFF` |
| `state.inactiveSelectedBackground` | `--ui-surface-selected-inactive` | `#ECEAE4` | `#30302D` |
| `state.inactiveSelectedForeground` | `--ui-state-inactive-selected-foreground` | `#5D5A53` | `#C6C4BC` |
| `state.disabledBackground` | `--ui-state-disabled-background` | `#EAE8E2` | `#30302D` |
| `state.disabledForeground` | `--ui-state-disabled-foreground` | `#77746D` | `#98968E` |
| `state.disabledSelectedBackground` | `--ui-state-disabled-selected-background` | `#E1DFD8` | `#343430` |
| `state.disabledSelectedForeground` | `--ui-state-disabled-selected-foreground` | `#706D65` | `#A3A198` |
| `state.disabledBorder` | `--ui-state-disabled-border` | `#C8C5BD` | `#595953` |

#### 主操作与危险操作（8）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `action.background` | `--ui-action-bg` | `#176985` | `#176985` |
| `action.hoverBackground` | `--ui-action-bg-hover` | `#155B74` | `#1B7896` |
| `action.pressedBackground` | `--ui-action-bg-pressed` | `#104C62` | `#125C74` |
| `action.foreground` | `--ui-action-foreground` | `#FFFFFF` | `#FFFFFF` |
| `danger.background` | `--ui-danger-bg` | `#B42332` | `#A93440` |
| `danger.hoverBackground` | `--ui-danger-bg-hover` | `#9E2632` | `#B93D49` |
| `danger.pressedBackground` | `--ui-danger-bg-pressed` | `#831D2A` | `#8D2C38` |
| `danger.foreground` | `--ui-danger-foreground` | `#FFFFFF` | `#FFFFFF` |

#### 状态提示（16）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `status.success` | `--ui-status-success` | `#0F6B5E` | `#87CDB3` |
| `status.warning` | `--ui-status-warning` | `#755900` | `#E5C66F` |
| `status.danger` | `--ui-status-danger` | `#AD303B` | `#F09198` |
| `status.info` | `--ui-status-info` | `#176985` | `#8CCFE2` |
| `status.successBackground` | `--ui-status-success-background` | `#EAF4EE` | `#1D3029` |
| `status.successForeground` | `--ui-status-success-foreground` | `#0F6B5E` | `#87CDB3` |
| `status.successBorder` | `--ui-status-success-border` | `#0F6B5E` | `#87CDB3` |
| `status.warningBackground` | `--ui-status-warning-background` | `#FFF4D6` | `#332D1B` |
| `status.warningForeground` | `--ui-status-warning-foreground` | `#755900` | `#E5C66F` |
| `status.warningBorder` | `--ui-status-warning-border` | `#755900` | `#E5C66F` |
| `status.dangerBackground` | `--ui-status-danger-background` | `#FBECEE` | `#392426` |
| `status.dangerForeground` | `--ui-status-danger-foreground` | `#AD303B` | `#F09198` |
| `status.dangerBorder` | `--ui-status-danger-border` | `#AD303B` | `#F09198` |
| `status.infoBackground` | `--ui-status-info-background` | `#EAF2F6` | `#1E2D37` |
| `status.infoForeground` | `--ui-status-info-foreground` | `#176985` | `#8CCFE2` |
| `status.infoBorder` | `--ui-status-info-border` | `#176985` | `#8CCFE2` |

#### 遮罩与阴影（5）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `overlay.scrim` | `--ui-overlay-scrim` | `#24231F40` | `#00000070` |
| `shadow.softAmbient` | `--ui-shadow-soft-ambient-color` | `#2927200D` | `#00000030` |
| `shadow.softKey` | `--ui-shadow-soft-key-color` | `#29272008` | `#0000001A` |
| `shadow.deepAmbient` | `--ui-shadow-deep-ambient-color` | `#29272018` | `#00000050` |
| `shadow.deepKey` | `--ui-shadow-deep-key-color` | `#29272010` | `#00000028` |

#### 搜索高亮（5）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `highlight.background` | `--ui-highlight-background` | `#FFF0B3` | `#3B301B` |
| `highlight.foreground` | `--ui-highlight-foreground` | `#523900` | `#F6E4B2` |
| `highlight.activeBackground` | `--ui-highlight-active-background` | `#FFE08A` | `#594316` |
| `highlight.activeForeground` | `--ui-highlight-active-foreground` | `#422B00` | `#FFF2CB` |
| `highlight.activeBorder` | `--ui-highlight-active-border` | `#805400` | `#E2C472` |

#### 拖放反馈（7）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `drop.allowedBackground` | `--ui-drop-allowed-background` | `#EAF4EE` | `#1D3029` |
| `drop.allowedForeground` | `--ui-drop-allowed-foreground` | `#0F6B5E` | `#87CDB3` |
| `drop.allowedBorder` | `--ui-drop-allowed-border` | `#0F6B5E` | `#87CDB3` |
| `drop.forbiddenBackground` | `--ui-drop-forbidden-background` | `#FBECEE` | `#392426` |
| `drop.forbiddenForeground` | `--ui-drop-forbidden-foreground` | `#AD303B` | `#F09198` |
| `drop.forbiddenBorder` | `--ui-drop-forbidden-border` | `#AD303B` | `#F09198` |
| `drop.insertionIndicator` | `--ui-drop-insertion-indicator` | `#145F79` | `#86CDE2` |

#### 链接（6）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `link.foreground` | `--ui-link-foreground` | `#176985` | `#8CCFE2` |
| `link.hoverForeground` | `--ui-link-hover-foreground` | `#145B75` | `#B4E0EC` |
| `link.pressedForeground` | `--ui-link-pressed-foreground` | `#104C62` | `#D1EDF4` |
| `link.visitedForeground` | `--ui-link-visited-foreground` | `#69527A` | `#C5A9D0` |
| `link.visitedHoverForeground` | `--ui-link-visited-hover-foreground` | `#554265` | `#DAC5E0` |
| `link.visitedPressedForeground` | `--ui-link-visited-pressed-foreground` | `#453751` | `#E9DCEC` |

#### 反色面（4）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `surface.inverse` | `--ui-surface-inverse` | `#37352F` | `#E7E5DE` |
| `text.inverse` | `--ui-text-inverse` | `#F7F6F3` | `#252523` |
| `border.inverse` | `--ui-border-inverse` | `#A6A39A` | `#7E7C75` |
| `focus.inverseRing` | `--ui-focus-inverse-ring` | `#95A5B2` | `#5A6C7B` |

#### 分类槽位（18）

| 角色 | CSS 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `category.1.background` | `--ui-category-1-background` | `#E8F0F8` | `#243A50` |
| `category.1.foreground` | `--ui-category-1-foreground` | `#294B6B` | `#A8C8E5` |
| `category.1.border` | `--ui-category-1-border` | `#294B6B` | `#BCD4E8` |
| `category.2.background` | `--ui-category-2-background` | `#F1EAF3` | `#4B3853` |
| `category.2.foreground` | `--ui-category-2-foreground` | `#61416D` | `#D5AEE1` |
| `category.2.border` | `--ui-category-2-border` | `#61416D` | `#D7BCE0` |
| `category.3.background` | `--ui-category-3-background` | `#E8F1EC` | `#28483D` |
| `category.3.foreground` | `--ui-category-3-foreground` | `#31594C` | `#8FCBB1` |
| `category.3.border` | `--ui-category-3-border` | `#31594C` | `#A8D2BE` |
| `category.4.background` | `--ui-category-4-background` | `#F4ECE2` | `#563B2B` |
| `category.4.foreground` | `--ui-category-4-foreground` | `#74492B` | `#D9AF86` |
| `category.4.border` | `--ui-category-4-border` | `#74492B` | `#DFC5A7` |
| `category.5.background` | `--ui-category-5-background` | `#F4E9EC` | `#54343D` |
| `category.5.foreground` | `--ui-category-5-foreground` | `#713E4A` | `#D89BAA` |
| `category.5.border` | `--ui-category-5-border` | `#713E4A` | `#DDB5BE` |
| `category.6.background` | `--ui-category-6-background` | `#F0EFDE` | `#47471F` |
| `category.6.foreground` | `--ui-category-6-foreground` | `#5B591F` | `#C9C88C` |
| `category.6.border` | `--ui-category-6-border` | `#5B591F` | `#D5D3A9` |

### COL-02｜深色如何从亮色重新建立

深色不是 RGB 逐通道取反，也不通过滤镜把白色页面反转。保留亮色的角色关系：内容与辅助区只作细微区分，控件和浮层略亮，悬停与按下逐步加亮；暖灰文字与底面保持一致色温，蓝色强调变亮并控制饱和感。

调色按以下顺序完成：

1. 固定亮色的白、米白、暖深灰与两级中性交互底色；把深色基础表面重建为暖炭灰，避免沿用旧灰绿色。
2. 在深色基面上提高文字、图标与强调色的亮度，选择中性选中底色；状态色、分类色和搜索高亮分别配置柔和底色与清楚的前景。
3. 对照登记表的每一组前景／背景关系计算对比度。文字至少 4.5:1，必要边界、光标和焦点至少 3:1；禁用配对按登记豁免，装饰分隔线和阴影不冒充必要边界。阈值依据 [WCAG 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)与[非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。
4. 以最不利的允许背景修正颜色，直至亮暗两套均通过；最后再核对层次和实际渲染。计算通过只证明这些配对，不等于应用已完成可访问性验收。

计算使用与项目校验器相同的相对亮度公式：将每个 sRGB 通道归一化至 0–1；当通道值 `c ≤ 0.04045`，线性值为 `c / 12.92`，否则为 `((c + 0.055) / 1.055)^2.4`。相对亮度 `Y = 0.2126R + 0.7152G + 0.0722B`；对比度为 `(较亮 Y + 0.05) / (较暗 Y + 0.05)`，以未四舍五入的结果判断阈值。

本版配色按当前登记表的 109 个角色、356 组关系校验：346 组有数值阈值，另外 10 组是登记明确的禁用豁免。亮暗两套各通过全部 346 组有效关系；下表为按阈值分类的实际最小值，显示值保留三位小数，判定使用原始精度。

| 计算范围 | 亮色最低对比度 | 深色最低对比度 | 阈值 |
| --- | --- | --- | --- |
| 文字类配对（160 组／主题） | 4.882:1 | 4.747:1 | ≥4.5:1 |
| 必要边界／指示类配对（186 组／主题） | 3.412:1 | 3.314:1 | ≥3:1 |

本节色值已同步至内置主题和生成配色，透明阴影与遮罩不属于上述不透明配对计算。深色取值是按视觉角色重建、由对比度计算约束得到的一套设计方案，不是把每个亮色色值代入同一个取反公式。

焦点角色在全部允许邻接面上的最低对比度：亮色 `focus.ring` 3.412:1、`focus.inverseRing` 4.848:1；深色分别为3.531:1、4.310:1。降低的是饱和度，不能通过透明化或取消键盘焦点来降低存在感。

主题系统只会按 `type` 补齐缺省值及角色引用，**不会自动把亮色计算成深色，也不会继承另一主题**。内置主题分别显式填写完整的 109 个角色，避免未覆盖项随缺省值变更而偏离预设；自定义主题仍允许按契约只填写部分角色。

### COL-03｜配对、边界与强调

- 同一状态的背景和前景成套取用；主操作三态使用 `action.*`，危险操作使用 `danger.*`，不能借用普通悬停背景。
- 普通选中统一用中性灰底。文字选项、菜单与列表不附加对勾，混合态用短横；纯图标控件保留主图标居中；不再用彩色整圈、侧边粗线、Tab下划线或发光表达选中。复选框保留自身的勾选标记。
- `border.divider` 用于结构分隔，`border.decoration` 用于已有其他识别线索的轮廓；`border.default` 承担空输入等必要边界。`border.strong` 保留其契约用途，但不因悬停自动切换。
- `accent.foreground` 与 `accent.indicator` 继续表达其已登记的业务强调用途，普通控件选中不再引用 `accent.indicator`。普通中性面焦点用 `focus.ring`，反色面用 `focus.inverseRing`，两者为低饱和灰蓝且保持必要对比。焦点保留2px清晰实线，不用透明光晕代替，并与选中背景保持区分。
- `status.*` 与文字／图标共同表达状态；`category.1–6` 只表达分类，不隐含成功或失败；`highlight.*` 用于搜索高亮，当前命中需额外标记；`drop.*` 只用于真实放置反馈。
- 链接、已访问链接、反色面、文字选区均使用各自配对。不要以 `text.primary` 覆盖彩色状态块的专用前景，不通过组件整体 opacity 制造禁用态。

### MAT-01｜平面、边线与浮层

基面、停靠区、普通行与卡片默认无外投影。边线为 1px，相邻区域共享一条分隔线。输入常态、悬停和按下保持同一边框；焦点或校验可以显式改变边界，但不能改变尺寸或产生过渡闪动。

浮层按既有配方取色，不新增主题字段：`soft` 对应 `--ui-shadow-popover`，几何为 `0 8px 24px 0` 与 `0 2px 6px 0`；`deep` 对应 `--ui-shadow-dialog`，几何为 `0 20px 64px 0` 与 `0 2px 8px 0`。配方名称只表示层级；第 03 节限制其透明度，不能因此使用重投影。悬停不改变阴影，深色依靠更亮的浮层表面和细轮廓分离。

默认界面不使用模糊、噪点、暗角、渐变、高光描边或摄影式光照。平台原生阴影由系统管理。

## 04. 排版

### TYPE-01｜系统字体与作者内容

界面使用系统无衬线字体，不引入在线展示字体；路径与快捷键使用等宽字体。沿用现有变量：

```css
--ui-font-interface: -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif;
--ui-font-document: "Noto Serif CJK SC", "Source Han Serif SC",
  "Songti SC", SimSun, serif;
--ui-font-mono: ui-monospace, SFMono-Regular, Consolas,
  "Liberation Mono", monospace;
```

文稿衬线字体是阅读默认值；作者格式与阅读偏好优先，不为模仿参考风格强制重写文稿。界面不主动选用 Inter／Roboto／Geist；平台字体回退由系统决定。

### TYPE-02｜层级

| 角色 | 字号 / 行高 | 字重 | 用途 |
| --- | --- | --- | --- |
| Display | 40 / 48px，窄空间 32 / 40px | 600 | 欢迎页主要标题 |
| PageTitle | 32 / 40px，窄空间 24 / 32px | 600 | 内容页主标题 |
| Title | 20 / 28px | 600 | 分组与弹框标题 |
| Strong | 16 / 24px | 600 | 面板标题、关键名称 |
| Body | 16 / 24px | 400 | 界面正文 |
| Label | 14 / 20px | 500 | 控件与工具标签 |
| Caption | 13 / 20px | 400 | 元信息与辅助说明 |
| Mono | 13 / 20px | 400 | 路径、快捷键、标识符 |
| Document | 18 / 32px | 400 | 作者正文默认值 |

Spacious 的 Label 为 16 / 24px，Caption 为 14 / 20px；Compact 的 Label 仍为 14 / 20px，Caption 可为 12 / 18px。正常文本不再缩小。字重采用 400／500／600；中文不额外拉字距，不用全大写字距标签反复装饰分组。

### TYPE-03｜长内容与行宽

同排文字按基线对齐，图标按视觉中心对齐。名称与路径可省略，但可经提示、详情或复制获得完整值；路径优先保留末端名称。错误原因、正文与重要说明允许换行，不为整齐强行截断。

连续阅读默认最大行宽 720px，偏好范围 480–960px，随空间收缩。英文连续文本以约 65–75 个字符为行宽参考；该数值不机械等同于 65–75 个汉字。段落间距只属于显示层，不能自动写入空行。

## 05. 留白、密度与几何

### GEO-01｜共同尺度

本文 px 均为 100% UI 缩放下的逻辑 CSS 像素。字号与可缩放尺寸优先使用 rem，基准 1rem = 16px；边线用 px。禁止用整体 transform 模拟 UI 缩放。

间距继续使用 `--ui-space-0` 至 `--ui-space-13`：0、2、4、8、12、16、20、24、32、40、48、64、80、96px。父布局管理区域间距，组件管理内部间距。2px 只作精细校正，不能用紧缩留白弥补布局错误。

| 空间关系 | Comfortable | Spacious | Compact |
| --- | --- | --- | --- |
| 图标与文字／标签与输入 | 8px | 12px | 8px |
| 同组内容 | 16px | 24px | 12px |
| 面板内边距 | 24px | 32px | 16px |
| 独立分组间距 | 40px | 64px | 24px |
| 主要内容区内距 | 48px | 64px | 32px |

窄窗口时主要内容边距依次减至 32／24／16px；阅读区通常不低于 24px，极窄或高倍缩放可到 16px。留白用于解释关系，不为填满屏幕增加卡片。

### GEO-02｜密度与小圆角

默认 Comfortable，欢迎页等入口使用 Spacious；Compact 用于紧凑工具区或用户选择。参考稿的按钮内距映射到现有预设，不把整个桌面应用压成网页演示中的小按钮。

| 指标 | Comfortable | Spacious | Compact |
| --- | --- | --- | --- |
| 标准按钮／输入／单行条目最小高度 | 40px | 48px | 32px |
| 双行条目最小高度 | 72px | 88px | 56px |
| 独立小按钮／IconButton | 32px | 40px | 28px |
| 菜单最小行高 | 36px | 40px | 32px |
| 工具条／面板头最小高度 | 48px | 56px | 40px |
| 控件水平内距 | 16px | 24px | 12px |
| 功能图标 | 20px | 24px | 16px |

高度为最小值，允许长文与缩放增高。表单控件并列时，IconButton 与同组输入等高；上下文只选一种密度，不逐控件拼接。Portal 继承触发上下文密度，主题从同一应用根继承。

| 几何变量 | 本版目标 | 约束 |
| --- | --- | --- |
| `--ui-radius-control` | 0.375rem（6px） | 按钮、输入、Select |
| `--ui-radius-row` | 0.25rem（4px） | 列表、树、菜单行的反馈底色 |
| `--ui-radius-overlay` | 0.375rem（6px） | 菜单、Popover、Tooltip |
| `--ui-radius-dialog` | 0.5rem（8px） | Dialog、独立对象卡片；贴边 Sheet 接缝侧直角 |
| `--ui-focus-width` | 2px | 清晰实线，不以透明光晕代替 |
| `--ui-focus-offset` | 1px | 无边框控件的外侧焦点间隔 |
| `--ui-indicator-width` | 2px | 保留既有几何变量供必要数据标记使用，不绘制普通控件的选中框或Tab下划线 |

所有主题与密度共用这些圆角。停靠区、阅读底板和连续分区保持直角共享边界。

### GEO-03｜图标命中区

图标尺寸与命中区分开定义。常规图标操作推荐至少 32×32px，独立操作不得小于 24×24px。输入内部图标可以为 16px，但命中区不遮文字或相邻按钮。

分隔条为 1px 可见边线，拖拽命中带至少 8px，并提供等效菜单或键盘调节方式。手柄预留在固定槽位中，仅变化透明度；触摸场景不能依赖 hover 发现入口。

## 06. 布局与原生窗口

应用外壳由布局职责组织，业务页面通过公开贡献接入，不自行再套全局导航与外框。导航用米白／深色辅助面，正文用主要内容面；条目默认平铺，选择与工具反馈局部出现。

| 外壳参数 | 参考尺寸 |
| --- | --- |
| 自绘顶区／工具轨 | 48px，原生安全区另计 |
| 状态区 | 32px，入口页不强制显示 |
| 导航停靠区 | 默认 256px，允许 224–384px |
| 检查器 | 默认 320px，允许 280–448px |
| 主工作区 | 目标最小 560px，单区退化保底 320px |
| 分隔线／命中带 | 1px / 8px |

根据实际内容宽度把次要操作收入菜单、折叠检查器和导航，最后退化为单工作区。区域独立滚动，弹框长内容内部滚动；不因打开面板逐帧挤压正文，不为显隐更换编辑器实例。

桌面基准 1440×900，常规最小测试 960×640；UI 缩放 200% 后核心操作仍可达。窗口控制、拖动、缩放、最大化和安全区由平台适配负责，业务页面不模拟系统窗口按钮。临时窄窗不覆盖用户布局偏好。

## 07. 公共组件

### CMP-01｜按钮与对象

| 组件／变体 | 呈现与状态 |
| --- | --- |
| `Button ghost`／IconButton | 普通命令首选透明底；hover／pressed 使用完整 `state.*` 配对，无边框或阴影变化 |
| `Button secondary` | 表单取消、需要明确轮廓的次要动作；中性控件面与稳定必要边界，不跟随 hover 加深边框 |
| `Button primary` | 一个操作上下文至多一个明确主操作；三态 `action.*` 加同态前景，低饱和实色，不发光、不投影 |
| `Button danger` | 明确破坏性提交使用 `danger.*`；普通危险菜单项可用危险文字，保留对象及影响说明 |
| List／Tree／Table | 平铺、列对齐、统一密度；整行与行内操作命中区分离，当前项使用灰底，不附加对勾 |
| Tab／SegmentedControl | 当前项使用灰底，不附加对勾或绘制彩色下划线；名称与关闭位置稳定 |
| Tag／Badge | 小圆角中性标签；真实分类用 `category.*`，真实状态用 `status.*`，不混用语义 |
| 对象卡片 | 仅用于独立对象，`surface.control` 或所属内容面、1px 装饰轮廓、8px 圆角、无投影；不嵌套卡片分割普通表单 |

默认操作不为模仿网页模板强制加实色 CTA。文本Button的选中态不附加对勾；混合态显示短横。IconButton、编辑器纯图标工具和窄栏图标导航只使用中性选中底色与对应前景，主图标始终居中，不附加对勾、短横或多余占位。加载和选中变化不改变尺寸、文字起点、主图标位置或命中区。

动作命令的悬停或按下不等于已选中；持久选值或明确当前项使用选中背景。第三方组件的 `active` 类须按其实际含义适配，不能一律当作选中状态。

### CMP-02｜输入、选择与焦点

TextField、Textarea、SearchField 与 Select 的 `field` 形式共享文字、控件高度、6px 圆角、`surface.control` 和 `border.default`。常态、hover、按下与展开维持同一边框颜色；hover 只允许克制的背景反馈。只读保持可读、可聚焦复制，禁用采用完整禁用配对并阻止动作。

有边框输入聚焦时，在原边界内侧呈现与边框合并的 2px `focus.ring` 线，不留外侧间距、不改尺寸。SearchField 只在复合外框画一次；无效且聚焦时用 `status.dangerBorder` 的 2px 边界，保留错误文字或图标。按钮及无边框触发器使用独立外环，按实际外侧表面选择 `focus.ring` 或 `focus.inverseRing`；`focusSurface` 表达邻接面，不能按主题明暗猜测。

Select 的 `title` 形式服务布局标题切换，Strong 字号、600 字重、透明无边框；`toolbar` 服务紧凑编辑工具区，图标触发器 32×32px，与同组动作等高。所有形式共用下箭头、完整交互状态和键盘模型；消费者只管外部宽度和对齐，不覆盖内部 CSS。

标签与字段关联，不能只用 placeholder 表达名称；图标触发器提供可访问名称及当前值。下拉菜单用 `surface.floating`、6px 圆角与 `soft` 阴影，内距 4px；不小于触发器宽度，受视口约束，长项可换行、长列表内部滚动。方向键、字符定位、Enter／Space 与 Escape 沿用共享组件模型，输入法合成期间不抢占候选操作。

### CMP-03｜编辑器与业务状态

已有 Button、IconButton、Icon、TextField、Textarea、SearchField、Select、Dialog 从 `@lodestory/ui` 复用。本文其他组件规则不表示 UI 包已经导出这些组件。缺少公共变体时统一补充，不在插件内部重写控件皮肤。

正文、选区、格式应用和第三方编辑器实例由格式插件拥有。富文本工具栏继续按所属插件组织已定义的两行组合；窄窗整体横向滚动，不压缩命中区或任意增加一行。字体、标题、字号使用文字 Select，文字色与背景色用图标 Select，对齐用四个并列状态按钮。作者颜色样本属于内容，不改成主题蓝色，也不用作控件底色。

### CMP-04｜浮层与弹框

菜单、Popover 和 Tooltip 圆角 6px；常规独立菜单宽 224–384px，锚定浮层按内容与可用空间调整。菜单距锚点 4px，Tooltip 距锚点 8px、意图延迟 500ms；普通浮层距视口至少 8px，Dialog 至少 16px。

右键命令菜单使用更紧凑的尺寸：最小宽 176px、最大宽 384px，长标签与快捷键可撑开；鼠标操作时，菜单行高在当前密度基础上减少 4px，并保留文字行高加上下各 4px 的下限，粗指针沿用原密度。条目横向内距 8px，分隔线上下间距 4px。当前层级包含图标时统一保留 16px 图标列，无图标条目文字仍对齐；纯文字菜单不留图标空列。外框使用 `border.divider` 的 65% 不透明度，保留现有浮层背景、6px 圆角和 soft 阴影；强制色模式使用系统边框色。

右键菜单的悬停与键盘高亮使用 `state.selectedHoverBackground/Foreground` 中性灰配对，按下使用 `state.selectedPressedBackground/Foreground` 配对，以便在浮层底色上明确辨认当前操作。这是临时指向状态，不代表命令已执行或持久选中；禁用项不高亮。强制色模式使用 `Highlight/HighlightText`，不改变字号、尺寸或边框。

Dialog 宽度沿用常规 560px、窄 480px、宽 640px、大 800px，受视口宽高限制。8px 圆角，标题用 Title，说明用 Body 或 Caption；内距沿用密度，操作区距内容 24px、按钮间距 8px，默认右对齐并允许换行。操作区默认延续浮层表面，不由业务插件私设底色、负边距与接缝。每次打开时弹框居中；标题栏是拖动区，支持鼠标和触控直接移动，也可聚焦后用方向键移动 8px、Shift 加方向键移动 24px，Home 或双击标题栏恢复居中。弹框与视口边缘至少保持 16px。打开期间窗口尺寸或内容尺寸变化时保留当前位置，仅在越界时修正，不重新居中。标题栏固定，正文在弹框内部独立滚动；拖动期间按 Escape 撤销本次移动但不关闭弹框，非拖动状态仍沿用通常的 Escape 关闭规则。拖动位置是单次打开期间的临时呈现状态，关闭后不保存。

真实模态保留遮罩、焦点限制、关闭与焦点恢复。是否允许关闭由业务状态决定，失败保留输入；退出动画不能成为保存、导航、停用或资源释放的业务条件。浮层开合只淡入淡出，不移动、不缩放，不逐项延迟出现；Dialog 的位置只因用户主动拖动而即时改变，不对拖动位置做过渡。

## 08. 状态与交互反馈

### STATE-01｜组合顺序

通用状态优先级继续为：禁用选中 → 禁用 → 选中按下 → 选中悬停 → 失焦选中 → 选中 → 按下 → 悬停 → 默认。每次使用同态前景／背景，焦点与校验独立保留；禁用抑制 hover／pressed。主操作和危险操作在未选中时使用自身三态配对。

| 状态 | 要求 |
| --- | --- |
| Hover | 仅背景与必要的配对前景反馈；不变边框、不变阴影、不移动 |
| Pressed | 比 hover 更明确的背景反馈，立即生效；不缩放 |
| Selected | 中性灰底；文字选项／菜单／列表不附加对勾，混合态短横；纯图标控件保持居中且不叠加标记；hover／pressed采用对应组合，无彩色整圈或下划线 |
| Focus-visible | 低饱和灰蓝焦点立即可见，保持2px清晰边界；与中性选中背景独立，不渐显、不发光、不被其他状态盖住 |
| Disabled | 阻止动作，使用规定配对；不得用整组件 opacity 代替 |
| Read-only | 能查看和复制，不改变值，不伪装成禁用 |
| Invalid／Warning | 文字或图标加局部校验边界，不抖动、不清空输入 |
| Loading／Saved／Error | 依据真实业务状态原位更新，失败保留到处理或状态解除 |
| Inactive selection | 失焦后仍保留选择关系，不等同于 Disabled |

空状态、无搜索结果、无权限与失败使用不同说明：简短原因与可执行下一步，不以大型插画占满工作区。拖拽手柄只表达实际功能，不把所有卡片都伪装成可排序对象。

### MOT-01｜统一动效

普通允许的背景／配对前景及透明度过渡为 150ms；时间线事件文字悬停缩放为 500ms，显式声明属性；日期／时间偏移和摘要以 1.05 倍、主标题以 1.2 倍同步放大。输入、选区、焦点、按下、选值、禁用、结构重排与换主题即时；位移仅用于下述关联资产展开、收起和轻微漂浮，缩放仅用于关联资产展开、收起、悬停和点击，以及事件文字和打开时间线时主线生长。无呼吸圆环，循环动效仅用于下述资产节点的轻微漂浮。主线在显式打开或切换时间线时从左向右生长 400ms；主线完成后，刻度在 700ms 内从左向右、由下往上生长，数字标签随后在 500ms 内显现；节点再从左到右生长 1600ms，上方连接线从主轴向上、下方连接线从主轴向下生长，端点在连接线长成后用 200ms 淡入，标题同时用 400ms 淡入；标题淡入完成后描述再用 400ms 淡入；交互或减少动效时立即显示完整内容。系统原生光标与滚动遵循平台行为。

同主题颜色过渡须验证中间颜色对比，不能保证时直接替换；当前自定义主题不强制插值。主题切换始终跳过颜色过渡。系统或用户要求减少动效时，所有插值时长为 0ms，时间线事件文字维持原尺寸、主线和节点立即完整显示，静态状态提示保留，Tooltip 的 500ms 意图延迟不变。

时间线聚焦时，事件置于圆心，72px 圆形资产节点从中心按顺时针逐个展开，等距环绕事件。节点显示名称和类型，分类颜色使用主题角色。全部关联直接呈现，数量多时增加外圈，不显示分页和底部分类统计；超出窗口的圈层可在同一视图中滚动查看。展开后圆圈在各自位置附近上下左右漂浮 3–5px，周期 6–8.4 秒，方向和速度错开。悬停时当前圆圈暂停漂浮并略微放大，点击后先缩小再恢复原大小。收起时节点从当前漂浮位置回到中心，结束后恢复时间轴；窄窗口采用静态分类列表，减少动效时直接显示静态节点。动画参数见[动效规范](动效规范.md)。

共享变量名称不变：`--ui-duration-fast`、`--ui-duration-normal`、`--ui-duration-dialog` 均为目标 150ms，`--ui-motion-offset` 为目标 0px。时间线事件文字的 500ms 和主线生长的 400ms 和节点生长的 1600ms 时长由时间线插件私有变量定义，仅服务于各自效果，不新增主题颜色字段或服务。取消、快速反转、0ms 清理、Portal 偏好与保存保护详见[动效规范](动效规范.md)。

## 09. 图标与内容素材

功能图标统一单色线性风格，圆端点与连接，视觉描边约 1.5px；图标随尺寸校正描边，颜色继承所属配对前景。不混用 Emoji、实心插画和线性工具图标。头像、品牌素材、原生图标与真实内容按用途例外。

内容图片保留真实色彩，不为了深色主题强制压暗、去饱和或反色；缺失时保留合理占位。图标操作有可访问名称，辅助提示不能成为唯一识别方式。

## 10. 可访问性与验收

### A11Y-01｜最低要求

正常文字、说明、占位提示与选区文字至少 4.5:1；必要控件边界、状态指示与焦点至少 3:1。装饰线可以更弱，但不能承担唯一识别功能。禁用项按登记豁免；禁用原因的普通文字与可聚焦项的焦点仍满足对应要求。

状态不能只用颜色传达。核心操作键盘可达，焦点不被裁切或遮挡；强制颜色模式使用系统色并保留必要边界。模态管理焦点，关闭后回到合理位置；拖拽有等效操作，失败不清除用户输入。

### QA-01｜落地验收

1. 页面呈现白色内容、米白辅助区或对应暖炭灰层次；焦点为低饱和灰蓝，选中为中性灰底；文字项无附加勾，纯图标居中，无彩色选中整圈／Tab下划线、渐变、重阴影、胶囊按钮或悬停边框／阴影跳变。位移与缩放按 MOT-01 的时间线例外验收。
2. 对照完整角色表检查两套目标配色，再按登记表全部有效配对计算；分类槽保持可区分。检查值来自标准角色，不在页面硬编码色值或按主题 ID 分支。
3. 检查 1440×900／1280×800／960×640，100%／125%／150%／200% UI 缩放；文本、主操作和弹框不被裁切，长名称、路径、中英混排与错误信息可读。
4. 覆盖浅深内置主题及两套相同 `type` 的自定义主题；检查默认、悬停、按下、选中、组合态、只读、禁用、禁用选中、失焦选中、错误和独立焦点，几何不跳动。
5. Select／菜单／Dialog 展开、表单有输入、编辑器有选区时切主题；浮层同步换色，值、焦点、选区、实例与未保存内容保留。
6. 检查键盘、触摸无 hover、强制颜色和减少动效；普通与 0ms 下反复开合、取消、父级卸载、停用与保存失败均正确清理。
7. 同密度、同角色组件跨页面对照；格式插件的第三方样式不覆盖公共控件。macOS 与 Windows Tauri 客户区分别验收。

### QA-02｜验证边界

静态配色计算、主题标准校验与构建通过，都不能代替实际页面渲染与客户端验收。本版已同步配色、圆角、边框与动效代码，并检查代表性浏览器界面；这不等于 macOS／Windows Tauri 实机、全部缩放级别与全应用可访问性认证已经完成。

## 11. 与当前实现对齐

### TOK-01｜现有变量直接复用

颜色按第 03 节映射，字体按第 04 节，密度、空间与几何按第 05 节。不要为 Notion 风格另建 `--notion-*`、页面私有浅深色表或一套 Tailwind 固定色。`ThemeDefinition.colors` 只接受登记颜色，不携带字体、尺寸、圆角、时长或阴影几何。

现有排版变量 `--ui-font-size-*`／`--ui-line-height-*`、空间 `--ui-space-*`、控件与菜单高度、外壳宽高和 Dialog 宽度预设继续使用；Mono 复用 Caption 的字号与行高，不引用不存在的 `--ui-font-size-mono`。页面只选布局和密度，不覆盖公共组件内部样式。

### TOK-02｜2026-10-25 实施状态与验收边界

| 范围 | 已同步内容 | 验收边界 |
| --- | --- | --- |
| 内置主题与登记缺省 | 两套内置主题完整覆盖 109 个角色，字面量缺省同步新配色；保留角色引用以支持自定义主题联动 | 两套主题共 692 个必要对比配对通过；不将静态计算视为全应用认证 |
| 排版与密度 | 保留系统字体、20/28px Title、40/48/32px 控件；菜单选项使用36/40/32px菜单变量 | 不改变作者文稿字体、字号、格式或内容 |
| 圆角 | 控件／行／浮层／Dialog 统一为 6／4／6／8px，独立对象卡片8px | 平台窗口和真实数据节点按用途例外 |
| 状态与边界 | 输入边界稳定；亮暗主题和反色面均使用低饱和灰蓝焦点；普通选中统一灰底与同态前景，保留错误、禁用、只读及selectedPressed组合 | 文字项不附加对勾；图标按钮、窄栏图标导航与纯图标编辑工具不附加勾，保持居中；键盘焦点独立，仍需原生客户端确认 |
| 动效 | 允许的浮层和停靠内容仅150ms透明度变化，offset 0；时间线端点在入场后静态、树方向即时呈现；显式打开或切换时间线时主线生长400ms、刻度生长700ms、数字标签显现500ms，随后节点从左向右生长1600ms；事件文字悬停时主标题500ms放大至1.2倍、日期／时间偏移和摘要同步至1.05倍，标题短横线同步以scaleX伸至1.2倍且保持1px线宽；移出平滑恢复且无背景高亮 | 颜色继续同步替换；减少动效0ms且复位事件文字与标题短横线，不动画化正文几何或保存流程 |
| 格式插件界面 | 富文本工具沿用共享控件；Markdown的Crepe工具条、Slash菜单、链接与表格工具接入统一字体、圆角、阴影和状态配对，取消默认缩放与200ms过渡 | 仅适配编辑器界面，作者正文、文稿格式与真实块拖拽保留 |
| 公共能力与状态保留 | 复用原主题、UI、布局、文档与项目存储公开契约；换肤与显隐保留编辑器实例 | 不宣称在线安装、市场或任意运行时插件热装卸已经实现 |
| 验证 | 构建、主题标准核验、共享控件与插件定向测试，以及亮暗、自定义主题、浮层、减少动效和编辑实例的浏览器检查 | 全量回归的15项既有失败已在修订前HEAD复现，不宣称全量测试通过；macOS／Windows Tauri实机与完整性能轨迹待验收 |

### TOK-03｜实施顺序

先把完整目标写入两套内置主题，并协调登记表缺省值，运行 `pnpm generate:theme`；登记表发生变化时再运行 `pnpm generate:theme-docs`，随后执行 `pnpm check:theme-standard`。颜色名、CSS 变量名与配对关系不因本版换风格而改名。

再统一修改共享 tokens、UI 包、布局与现有界面的边框和动效实现，业务状态仍由原插件拥有。缺少变体时补最小共享接口，不向内核或入口添加业务连接。完成 QA-01 后才将对应项标记为已迁移。

## 12. 依据

- 用户提供的 `STYLEKIT_STYLE_REFERENCE`：Notion 风格描述，以及“冲突部分以新的设计要求为准”的确认。
- [主题标准 v1](../文档/主题标准-v1.md)、[颜色登记表](../src/plugins/theme/color-registry.json)与[公开 SDK](../packages/sdk/README.md)：现有契约与能力边界。
- [WCAG 2.2 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：对比度阈值与适用边界。
- [WCAG 2.2 操作目标尺寸](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)、[焦点可见](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)：键盘与命中区参考。本文 24px 独立命中区是产品基线，不把所有行内文字链接都按按钮几何处理。
