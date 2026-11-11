# @lodestory/sdk

Lodestory 插件使用的共享契约包，提供插件生命周期类型、能力与事件 key，以及配置、UI、应用导航布局、窗口外壳、主题、工作台布局、通用画布、时间线、项目存储、工作台和文档服务契约。它不包含宿主实现。

## 导出入口

- `@lodestory/sdk`：`Plugin`、`PluginContext`、`PluginStopCancelledError`、能力 key 与事件 key 类型和创建函数。
- `@lodestory/sdk/config`：JSON 配置值、配置项、配置服务类型，以及共享单例 `configKey`。
- `@lodestory/sdk/shortcuts`：命令、默认按键、作用域及用户覆盖接口，共享 `shortcutsKey`、命令 ID 和作用域 ID；实现见[快捷键插件](../../src/plugins/shortcuts/README.md)。
- `@lodestory/sdk/ui`：UI 服务类型与共享单例 `uiKey`。
- `@lodestory/sdk/navigation-layout`：应用导航布局服务、页面与导航元数据类型，以及共享单例 `navigationLayoutKey`。
- `@lodestory/sdk/settings`：设置分类贡献与打开弹框的契约，以及共享 `settingsKey`。
- `@lodestory/sdk/plugin-packages`：本地插件包导入、记录和外部能力声明契约，以及共享 `pluginPackagesKey`。
- `@lodestory/sdk/external-plugins`：外部插件加载状态与统一后端调用入口；插件工厂可从 `ExternalPluginOptions.backend` 调用自身后端。
- `@lodestory/sdk/plugin-runtime`：宿主通用的运行中插件激活和停用能力。
- `@lodestory/sdk/window-shell`：窗口外壳属性与服务类型，以及共享单例 `windowShellKey`。
- `@lodestory/sdk/error`：错误边界服务与共享单例 `errorUiKey`。
- `@lodestory/sdk/layout`：内容用途、登记描述、布局视图、快照和服务类型，以及共享单例 `layoutKey`。
- `@lodestory/sdk/canvas`：通用视口与画布表面服务类型，以及共享单例 `canvasKey`。
- `@lodestory/sdk/timeline`：时间线列表快照、命令与打开服务，以及共享单例 `timelineKey`。
- `@lodestory/sdk/asset-catalog`：按工作台会话读取只读资产目录快照，以及共享单例 `assetCatalogKey`。
- `@lodestory/sdk/workbench`：项目与工作台会话、参与者生命周期、快照和服务类型，以及共享单例 `workbenchKey`。
- `@lodestory/sdk/project-storage`：项目字节文件缓冲与存储服务类型，以及共享单例 `projectStorageKey`。
- `@lodestory/sdk/native-library-loader`：可信动态库的加载、调用和关闭契约，以及共享 `nativeLibraryLoaderKey`；原生函数约定见 [ABI 头文件](native/lodestory_native_library.h)。
- `@lodestory/sdk/project-search`：按会话登记搜索来源、查询与打开结果的契约，以及共享 `projectSearchKey` 和 `projectSearchRequested` 事件。
- `@lodestory/sdk/documents`：打开文档与文档工作区类型，以及 `documentsKey` 和新建/显示请求事件。
- `@lodestory/sdk/body-editor`：正文格式、编辑器定义与宿主传入的编辑器属性、正文 main 内容 ID；`EditorHandle` 可按需贡献通用上下文菜单操作，格式插件可通过 `EditorDefinition.conversions` 声明转换，由正文宿主统一提供另存为入口。插件可通过 `EditorDefinition.replaces` 声明按格式替代的旧编辑器映射，由注册表兼容读取已有配置。
- `@lodestory/sdk/context-menu`：共享菜单项类型、菜单区域属性类型，以及 context-menu 插件提供的 `contextMenuKey` 和 `ContextMenuService`。
- `@lodestory/sdk/theme`：主题定义、仅含 ID 的选择配置、选择策略、管理服务和快照类型，以及共享单例 `themeKey`。

正文格式插件可通过 `EditorHandle.getContextMenuActions()` 动态返回当前操作快照。每项操作由编辑器插件拥有，包含稳定的 `id`、`label`、可选 `disabled` 和 `run()`；正文宿主负责展示并在执行时复核编辑器生命周期与编辑状态。未提供该方法的编辑器无需贡献菜单操作。

编辑器可声明 `EditorDefinition.scrollMode: "editor"`，获得文稿区域内的有界高度，由自身安排固定工具栏和正文滚动容器；省略或使用 `"document"` 时沿用宿主整份文稿滚动。滚动状态属于当前文档的编辑器实例，切换文档时保留，关闭时随实例释放；该设置不改变内容读写与保存流程。

搜索来源由业务插件按工作台会话登记并在会话结束时撤销。来源提供当前记录、加载／错误状态、变更订阅和打开操作；`id` 在来源内唯一，`kind` 用于结果分组，`title`、`detail` 和 `text` 提供可搜索内容。索引服务不拥有原始数据，也不通过打开结果绕过来源的业务检查。`projectSearchRequested` 只请求展示搜索界面，并不会自动执行搜索或打开资源。当前实现及边界见[项目搜索插件](../../src/plugins/project-search/README.md)。

正文来源使用 `matchMode: "text-occurrences"` 返回独立命中位置，通过 `searchAsync` 分批获取结果；打开时将命中信息交还来源校验。文稿目录由工程管理插件提供；文档工作区提供优先读取当前编辑内容的 `readSearchText`，项目存储的 `readTransient` 不创建持久缓冲。格式编辑器可提供 `getSearchText` 提取可见文字，并通过编辑器句柄的 `revealSearchRange` 定位经校验的结果。调用方须处理取消、读取失败和格式不支持定位的情况。

存在原生输入合成状态的编辑器可提供 `EditorHandle.flushContent(currentContent?)`，同步提交已经发生的输入并返回完整持久化内容。传入的 `currentContent` 是宿主最新缓冲；格式实现应先接纳尚未通过 React 属性送达的外部替换，避免旧界面覆盖新内容。正文宿主会将该句柄通过文档工作区的可选 `registerContentReader(documentId, reader)` 接口登记；保存、切换和离开前由文档插件调用读取器并更新既有共享缓冲。读取错误会阻止对应操作，句柄失效后不能继续读取。登记返回的撤销函数只撤销自身批次，旧实例不能移除新实例的读取器。

## 生命周期与 key

快捷键消费者声明 `shortcutsKey` 依赖，通过 `registerCommand` 登记自己拥有的操作，通过 `registerBinding` 登记默认组合键；按钮和菜单通过 `execute` 复用业务入口。调用方保留并在停用时撤销登记，作用域的活动状态与 DOM 范围由所属插件提供。`execute` 的布尔值表示是否接收执行，不代表保存等业务操作成功；业务结果与错误仍由原服务管理。`getShortcut` 供界面显示实际生效的键；快照提供当前及默认绑定和用户覆盖状态。改绑通过 `setBinding/resetBinding`，同作用域冲突以 `ShortcutConflictError` 返回，不直接读写实现方的配置对象。

UI 服务拥有当前窗口的交互浮层状态。交互接入插件通过 `uiInteractionKey` 暴露查询与独立 React 根的包装能力，把组件库的通用通知转为 UI 服务的登记与撤销。快捷键插件声明该能力并查询活动浮层，浮层内的导航和 Escape 由组件处理。

设置插件通过 `settingsKey` 提供 `open(sectionId?)` 和 `registerSection`。功能插件在启动期声明依赖并登记自己的分类与渲染函数，停用前调用撤销函数；正在显示的分类会先从界面撤下。设置容器不拥有其他插件的配置值或业务实现，首版不承诺运行中安装或替换插件。

宿主创建 `EngineCore` 并挂载插件时调用 `activate(context)`。插件在其中用 `provide` 注册声明过的能力，用 `get` 读取声明的依赖，用 `on` 订阅事件，也可用 `emit` 发布事件。卸载或激活失败时，宿主调用可选的 `deactivate()`，并撤销该插件的能力和订阅。

页面、导航、根包装和布局内容等登记接口返回 `PluginContribution`。贡献者必须在 `activate` 中用 `context.track(登记结果)` 关联所有权，并保留句柄供激活失败及停用清理。单插件停用依次执行所有参与者的 `check`、`prepare` 和 `withdraw`，撤回完成后才调用 `deactivate`；检查、准备或撤回失败会保留插件及依赖，重试不会重复已成功撤回的登记。`context.onStop` 可登记其他通用参与者，`prepare` 适合保存检查，失败时必须保留用户数据。整窗停止使用 `application` 范围，单插件使用 `plugin` 范围；根包装层拒绝单插件在线撤回。React 组件的异步清理须由参与者明确等待，不能依赖普通 Effect 清理返回 Promise。当前仍只在启动期登记页面与根包装，不提供运行中安装。

用户主动取消停止时，参与者可以抛出 `PluginStopCancelledError`；应用会保留窗口，不将取消当作错误提示。实际保存或清理失败应返回具体错误，不使用这个类型掩盖失败。

正文格式编辑器的登记句柄也必须交给 `context.track`。目前正文宿主会拒绝在运行中单独撤回格式编辑器，避免正在使用的编辑器和未提交输入被意外销毁；整窗停止仍可释放它。

能力和事件 key 含有一个 `Symbol` token，运行时按 token 查找；`id` 只用于说明和诊断。同一项能力或事件的参与方必须导入契约包中同一个 key 实例。重新调用工厂创建同名 key 会得到不同 token，无法互相匹配；不要为了复用而把 `Symbol` 改成全局注册。

```ts
import { createServiceKey, type Plugin } from "@lodestory/sdk";

type Clock = { now(): number };
export const clockKey = createServiceKey<Clock>("example/clock");

export const clockProvider: Plugin = {
  id: "example.clock",
  requires: [],
  provides: [clockKey],
  activate(context) {
    context.provide(clockKey, { now: () => Date.now() });
  },
};

export const clockConsumer: Plugin = {
  id: "example.consumer",
  requires: [clockKey],
  provides: [],
  activate(context) {
    console.log(context.get(clockKey).now());
  },
};
```

事件 key 同样由共享契约模块创建；发布方和订阅方导入同一个实例：

```ts
import { createEventKey, type Plugin } from "@lodestory/sdk";

export const savedEvent = createEventKey<{ documentId: string }>("example/document-saved");

export const observer: Plugin = {
  id: "example.observer",
  requires: [],
  provides: [],
  activate(context) {
    context.on(savedEvent, ({ documentId }) => console.log("saved", documentId));
  },
};

// 保存方在自己的 activate(context) 中发布：
// await context.emit(savedEvent, { documentId: "doc-1" });
```

## 配置服务

配置项由拥有它的功能插件声明，并导出给其他插件共用。配置服务通过 `configKey` 提供 `register`、`getSnapshot`、`set`、`reset` 和 `subscribe`；SDK 只定义类型与 key，不绑定文件、浏览器或系统设置存储。配置项 ID 使用稳定的 `插件名.配置名`，值限于 JSON 数据。

```ts
import type { Plugin } from "@lodestory/sdk";
import { configKey, type ConfigItem } from "@lodestory/sdk/config";

export const fontSizeConfig: ConfigItem<number> = {
  id: "editor.fontSize",
  defaultValue: 18,
  effect: "live",
  validate: (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 12 && value <= 40,
};

let removeConfig: (() => void) | undefined;
let removeListener: (() => void) | undefined;
export const editorPlugin: Plugin = {
  id: "example.editor",
  requires: [configKey],
  provides: [],
  activate(context) {
    const config = context.get(configKey);
    removeConfig = config.register(fontSizeConfig);
    const apply = () => applyFontSize(config.getSnapshot(fontSizeConfig));
    apply();
    removeListener = config.subscribe(fontSizeConfig, apply);
  },
  deactivate() {
    removeListener?.();
    removeListener = undefined;
    removeConfig?.();
    removeConfig = undefined;
  },
};
```

所属插件在启动期登记配置项；使用者通过 `requires: [configKey]` 声明服务依赖，并导入同一个配置项声明。跨插件读取应声明对配置所属插件提供的能力的依赖，确保登记方先完成激活。`register` 与 `subscribe` 都返回幂等撤销函数；配置登记撤销不删除已保存值。`getSnapshot` 返回深只读的有效值，值未变时快照引用稳定。`set`、`reset` 都是异步操作：先校验并保存，只有保存成功后才更新快照和通知监听者；失败会拒绝且保留旧值。

有效值优先级为**用户覆盖值 → 应用基础配置 → 声明默认值**。配置项的 `effect: "live" | "restart"` 只描述生效时机；配置服务不替插件应用配置。`live` 项由所属插件订阅并应用；`restart` 项由所属插件在启动时读取。本仓库首版由独立 `config` 插件读取 [`config.json`](../../src/plugins/config/config.json) 作为基础值，并用 `localStorage` 键 `lodestory.config-overrides` 保存用户覆盖。无效用户值会报告并回退到下一层；该存储策略属于应用实现，不是 SDK 协议。现有主题偏好仍由主题插件管理，本次不迁移。

UI 插件声明并导出 `uiInitialPageConfig`（ID 为 `ui.initialPage`，默认值为 `null`，生效方式为 `restart`）。配置插件提供 `welcome` 基础值。UI 在全部页面完成登记后读取它并选择启动页；运行期间 `set` 此项只更新配置，不触发跳页。配置指向未登记页面会使启动失败并回滚插件。

## UI 与主题

页面插件通过 `@lodestory/sdk/ui` 声明对 `uiKey` 的依赖并登记页面；UI 宿主负责调用页面并保留已访问页面。应用应共享同一份 React 运行时。此入口只把 `ReactNode` 用作类型，因此 SDK 没有 React 运行时依赖；使用 UI 类型的项目须安装 `@types/react`。它声明为可选 peer，因此只使用核心或主题契约的项目无需安装 React 类型。

```sh
npm install --save-dev @types/react@^19.1.8
```

```tsx
import { type Plugin } from "@lodestory/sdk";
import { uiKey } from "@lodestory/sdk/ui";

let removePage: (() => void) | undefined;

export const pagePlugin: Plugin = {
  id: "example.page",
  requires: [uiKey],
  provides: [],
  activate(context) {
    const ui = context.get(uiKey);
    removePage = context.track(ui.registerPage({
      id: "example",
      render: ({ params, active }) => <main hidden={!active}>{String(params ?? "")}</main>,
    }));
  },
  deactivate() {
    removePage?.();
    removePage = undefined;
  },
};
```

`UiWrapper.prepare` 是可选的根视图准备回调：所有初始插件激活后，UI 按 `order` 依次执行并等待，再创建 React 根。准备失败使启动回滚；回调不能等待尚未创建的 UI，也不能依赖较晚的 `pluginsReady` 监听者完成。

主题管理器和其他插件共享 `themeKey`。内置与自定义主题在同一目录中按 ID 选择，`type` 只是深浅属性，用于原生窗口外观、标准缺省值及跟随系统时的匹配。注册返回清理函数，贡献主题的插件卸载时必须调用：

```ts
import { type Plugin } from "@lodestory/sdk";
import { themeKey } from "@lodestory/sdk/theme";

let removeTheme: (() => void) | undefined;
export const inkThemePlugin: Plugin = {
  id: "example.ink",
  requires: [themeKey],
  provides: [],
  activate(context) {
    const theme = context.get(themeKey);
    removeTheme = theme.registerTheme({
      schemaVersion: 1,
      id: "example.ink.dark",
      name: "墨色写作",
      type: "dark",
      colors: { "surface.content": "#171A23", "text.reading": "#ECE2CE" },
    });
    // 在用户选择时调用；仅注册不会更改当前选择。
    // theme.setPreference({ mode: "fixed", themeId: "example.ink.dark" });
    console.log(theme.getSnapshot().themes);
  },
  deactivate() {
    removeTheme?.();
    removeTheme = undefined;
  },
};
```

`setPreference({ mode: "system", lightThemeId, darkThemeId })` 指定系统浅色和深色时各用哪套主题；两个 ID 必须已登记且属性匹配。`getSnapshot().theme` 是实际使用的完整主题；启动准备前或目录为空时为 `null`，读取颜色前须判断。缺省颜色来自标准登记表，不继承另一主题。已选主题移除后保留选择并回退，重新登记后自动恢复，`unavailableThemeId` 用于显示提示。

主题管理插件自行读取 [theme-config.json](../../src/plugins/theme/theme-config.json)，按 `ThemeConfig` 处理；应用仅装配插件。其中 `defaultThemeId` 和 `fallbackThemeIds.dark/light` 都只是 ID。管理器先提供 `themeKey`，包括 [builtin-themes](../../src/plugins/builtin-themes/builtinThemesPlugin.ts) 在内的所有配色插件统一按上例登记。初始插件全部激活后，主题包装层的 `prepare` 校验默认与回退 ID，再应用配色、等待原生同步；UI 随后才挂载。缺失或属性不匹配会中止启动，没有内置配色专用入口。

设置页读取 `getSnapshot().fallbackThemeIds` 初始化系统槽位，不导入具体配色文件。内置和自定义贡献都可撤销；若配置的回退项也缺失，则依次选择同属性的其他项、任一剩余项，目录为空时返回 `null`。默认职责是 ID 配置，所有主题仍平级。

当前注册处理同一进程中已加载的主题数据，检查格式、角色名称及透明度；主题包导入、持久化安装、B 对比度警告尚未接入。自定义主题须由插件在每次启动时重新登记。设计见[主题管理](../../文档/需求设计/主题管理.md)，数据契约见[主题标准 v1](../../文档/主题标准-v1.md)。

## 应用导航布局

`navigation-layout` 插件通过共享单例 `navigationLayoutKey` 提供应用级导航布局（ID：`app/navigation-layout`），与工作台内部的 `layoutKey` 分开。`registerPage` 登记页面及导航信息；`registerAction` 登记不切换页面的导航操作。两者共享 ID 空间和 `navigation: { label, icon?, order?, group?: "primary" | "secondary" }`；默认实现按分组、顺序和 ID 排列，登记均返回撤销函数。

欢迎插件登记页面，设置插件登记打开弹框的操作。点击页面入口由布局调用 `ui.openPage(id)`；点击操作入口则调用贡献者提供的函数，不改变路由或历史。两类贡献在启动期登记，通过 `context.track` 关联的句柄支持受控在线撤回。替换导航布局时须同时实现页面、操作和生命周期句柄契约。

替代实现须保留页面 ID、`params` 和 `active` 语义，并在切页后保留已访问页面的组件实例，以兼容 UI 服务的页面生命周期。

页面可在运行中登记，`registerPages` 支持成组登记。单插件停用时 UI 先经守卫离开目标页面，再移除页面和导航条目，其他页面保留。整体停止时先完成保存检查并卸载根视图，再按逆依赖顺序释放插件。实现位于 [`src/plugins/navigation-layout/`](../../src/plugins/navigation-layout/README.md)。

## 窗口外壳

`@lodestory/sdk/window-shell` 导出共享单例 `windowShellKey`（ID：`app/window-shell`）、`WindowShellProps` 和 `WindowShellService`。属性为 `{ children, showBrowserTitlebar? }`；服务只提供稳定的 `View: ComponentType<WindowShellProps>`，不创建 React root，也不管理页面导航。默认 `window-shell` 插件由 `appPlugins` 静态装配，以 `themeKey` 为依赖并通过 `windowShellKey` 提供 `PageShell`。

`showBrowserTitlebar` 默认 `true`，只控制浏览器中的模拟标题栏；Tauri 始终不显示它。`navigation-layout` 使用默认值，`workbench` 传入 `false`。插件页面应声明 `windowShellKey` 依赖，并在其 UI 页面撤销前停止使用 `View`。同一次插件激活期间，替代实现提供的 `View` 身份须保持稳定，普通更新和页面切换不能重挂载 `children`。插件替换由下一次 `appPlugins` 静态装配选择，不承诺跨实现或重启保留 React 实例。

`PageShell` 和专属的 `app-shell`、`window-titlebar` 样式由 `window-shell` 插件拥有。该插件不创建全局服务单例、不监听事件、不使用计时器；组件资源随 React 挂载管理。停用时由依赖顺序确保消费者先撤销 UI 页面，Core 随后清理能力；插件无需额外的空 `deactivate`。公共 `src/styles.css` 保留原位置，由 `navigation-layout` 和 `workbench` 显式导入。

## 布局服务

布局能力独立于页面导航。功能插件声明 `requires: [layoutKey]`，通过 `registerContent({id, title, role, order?, render})` 按用途登记；`role` 为 main、navigation、auxiliary、actions 或 status，不指定位置。工作台页面挂载服务的 `View`，布局实现决定如何显示这些内容。`show`/`hide` 控制展示，`getSnapshot`/`subscribe` 提供不可变目录和展示状态。完整接入与生命周期见[布局插件设计](../../文档/需求设计/布局插件.md)。

登记描述可附带 `icon?: ReactNode` 作为入口的装饰图标，由贡献插件提供，不绑定宿主图标集合。默认布局用于左侧导航入口；未提供时沿用文件图标，其他布局也可使用文字入口。图标不替代 `title` 和无障碍名称。

隐藏内容保留组件实例，并传入 `active: false`；工作台切到后台时所有内容也收到 false。登记函数须在激活时调用，并将返回句柄交给 `context.track`；单插件停用时布局同步撤回该内容并保留其他内容。布局实现的替换仍发生在下一次装配。此入口也只有 React 类型依赖，不导入 React 运行时代码。

`main` 内容按用途互斥：`show(id)` 选择当前 main 项，布局快照的 `shownIds` 只包含选中的 main。标签等相关区域若只适用于某个 main，应订阅 `layoutKey` 的 `getSnapshot()` / `subscribe()`，并使用对应功能公开的内容 ID 判断是否展示；布局不解释 ID 的业务含义，也不需要增加业务事件。

## 通用画布服务

`@lodestory/sdk/canvas` 导出共享单例 `canvasKey`。通用 `canvas` 插件提供画布表面与视口状态：视口快照包含中心坐标、缩放比例和销毁状态；调用 `panBy`、`zoomTo`、`resetZoom`、`resetView` 可改变视口，返回布尔值表示操作是否接受。缩放以可选的指针锚点为中心，并限制在 25% 到 400%。画布表面接收 `viewport`、`active`、`label` 和可选子内容；`grid` 可选 `"dots"`（默认）或 `"none"`，不含业务语义。

画布服务只负责通用视口和手势，不定义时间线、事件或文件格式。具体功能插件通过 `canvasKey` 创建视口并拥有它们的用途和生命周期；当前时间线插件按项目会话和时间线条目保留视口，结束会话或删除条目时释放。视口位置只保留在当前会话内，不写入项目文件。

## 时间线服务

`@lodestory/sdk/timeline` 提供共享 `timelineKey`。`timeline` 拥有时间线列表元信息、事件数据、当前选中项、数值轴设置和视口，通过工作台参与者管理项目会话。`outline-design` 通过公开服务订阅列表并发出新建、删除、打开请求；不直接导入列表模型、读写文件或创建视口。列表快照中的 `eventCount` 和 `period` 是事件与轴设置派生出的展示值，不写入既有列表元信息文件。事件编辑和事件文件格式由 `timeline` 插件内部拥有，当前不另设跨插件事件 CRUD 契约。打开操作校验当前会话并通过布局显示时间线 main 内容。

`@lodestory/sdk/asset-catalog` 提供共享 `assetCatalogKey`。资产管理插件拥有资产类型、资产记录及其属性，并按工作台会话发布只读目录；类型与资产条目仅包含类型 ID、名称和状态，以及资产 ID、名称、说明和类型 ID，不暴露属性值或私有 store；快照另含 `loaded`、`loading`、`error`、`blocked` 状态。类型和资产 ID 都是稳定的规范小写 UUID，消费者可以将资产 ID 作为不透明引用保存；类型 ID 与资产的 `typeId` 对应，未分类资产使用 `typeId: null`。目录提供稳定快照、订阅和重试能力，会话结束后失效且不能再重试；没有对应活动会话时 `getCatalog` 返回 `null`。类型保留 `active` 和 `archived` 状态。消费者可自行按类型筛选或搜索目录内容，资产目录不提供查询或修改命令。

原点世界坐标表示故事起点，其显示数值、刻度间隔和单位由作者设置。事件保存相对故事起点的 `offset`；其标签数值按 `origin + offset` 计算，所以修改起点会同步更新显示值。数值轴实现、事件 JSON 与配置 JSON 属于提供者内部，不加入通用画布接口。现有列表文件路径和格式保持兼容；轴和事件数据分别使用独立文件。契约消费方不拥有服务的清理权，插件在撤回 UI 后释放模型和视口。详见[时间线插件](../../src/plugins/timeline/README.md)。

## 工作台服务

工作台通过 `workbenchKey` 提供项目会话服务。`openProject(project)` 在离开检查通过后提交工作台页面，并在后台启动会话；其 `true` 表示页面已进入，不表示项目已加载完毕。`closeProject()` 检查并结束当前会话。离开被拒绝时返回 `false`，导航错误以 Promise rejection 报告。`getSnapshot()` 与 `subscribe()` 提供 `{session, active, busy, loading}` 状态：`loading` 提供完成数、总数、可选阶段名称和失败信息；启动成功后为 `null`。失败时工作台继续保持 `busy`，可通过 `retryProject()` 重试或 `returnProject()` 返回原项目／欢迎页。`registerParticipant()` 返回异步生命周期句柄，须用 `context.track` 关联所有者。单插件停用会执行其资源的 `beforeLeave("unload")`，检查通过并撤回该插件视图后只清理其资源；其他参与者和项目会话保留。

项目会话由 `{id, project: {id, name, path}}` 构成。参与者在页面进入后按登记顺序执行 `start(session)`，返回 `beforeLeave(reason)` 和 `dispose()`；可选 `label` 用于展示当前加载阶段。参与者负责清理未成功返回的部分资源；项目真正结束时工作台在视图停止使用后按启动逆序清理已返回资源。`suspend` 代表暂时离开工作台，检查通过后保留会话和资源；切换项目时旧会话保留到新会话准备成功，失败可返回旧会话。`busy` 期间 UI 应阻止新的编辑操作，已有保存继续执行。统一离开检查覆盖 UI 页面 `open`、`back`、同页项目替换和原生窗口关闭。详细规则见[工作台插件设计](../../文档/需求设计/工作台插件.md)。

## 文档服务

`@lodestory/sdk/documents` 提供应用级 `documentsKey`，由文档管理插件实现。它按工作台会话返回同一个 `DocumentWorkspace`，负责文档打开项、选择，以及打开、关闭和新建等文档业务流程。每个 workspace 的快照包含当前打开文档、选中文档、打开/创建状态和错误；正文插件可以订阅快照并从中派生当前文档。文档 ID 只在工作区内有效，文档路径相对于项目根目录。正文内容缓冲和磁盘保存由项目存储服务提供。

```ts
import type { Plugin } from "@lodestory/sdk";
import { documentsKey } from "@lodestory/sdk/documents";
import { workbenchKey } from "@lodestory/sdk/workbench";

let removeParticipant: (() => Promise<void>) | undefined;
export const editorPlugin: Plugin = {
  id: "example.editor",
  requires: [documentsKey, workbenchKey],
  provides: [],
  activate(context) {
    const documents = context.get(documentsKey);
    const workbench = context.get(workbenchKey);
    removeParticipant = context.track(workbench.registerParticipant({
      id: "example.editor",
      start(session) {
        const workspace = documents.getWorkspace(session.id);
        if (!workspace) throw new Error("The document workspace is unavailable.");
        const stop = workspace.subscribe(() => {
          const snapshot = workspace.getSnapshot();
          const current = snapshot.documents.find(document => document.id === snapshot.activeId);
          // 使用 current.content 和 current.saveState 更新正文与保存状态。
        });
        // 编辑时调用 workspace.update(document.id, nextContent)。
        return { dispose: stop };
      },
    }));
  },
  async deactivate() { await removeParticipant?.(); },
};
```

`open(path)` 已打开时复用现有项；延迟完成的读取不得抢回后来选择的文档。`create(parentPath, name)` 创建文件并直接加入打开列表，返回落盘后的文件名和相对路径。`update` 更新共享内容；具体缓冲和自动保存由 `projectStorageKey` 持有。`close` 先确保内容保存，失败时保留文档并重新选择它。`closeMany(ids)` 按传入顺序逐个关闭调用时已有的文档，遇到失败或会话不可操作时立即停止并返回 `false`，保留其余文档；已经关闭的目标会跳过，调用后新开或重新打开的文档不受影响。`save` 和 `saveAll` 返回布尔值表示是否保存成功；操作错误可从快照或具体文档的 `saveError` 读取。关闭工作区不会删除物理文件。

## 项目存储服务

`@lodestory/sdk/project-storage` 提供应用级 `projectStorageKey`，由项目存储插件实现。它按工作台会话返回一个共享 `ProjectFiles`，按项目相对路径管理不透明字节；正文通过 `DocumentWorkspace` 管理打开项和当前选择，大纲等业务插件使用同一字节服务，不创建正文标签，也不更改正文选择。

```ts
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";

const storage = context.get(projectStorageKey);
const workbench = context.get(workbenchKey);
const removeParticipant = context.track(workbench.registerParticipant({
  id: "example.storage-consumer",
  start(session) {
    const files = storage.getFiles(session.id);
    if (!files) throw new Error("Project storage is unavailable.");
    const unsubscribe = files.subscribe(() => {
      const snapshot = files.getSnapshot();
      // 由当前业务插件解释 snapshot.files 中的 bytes。
    });
    return {dispose: unsubscribe};
  },
}));
```

`ProjectStorageService.getFiles(sessionId)` 返回稳定的 `ProjectFiles`，提供 `read`、`create`、`write`、`save`、`saveAll`、`delete`、`list`、`createDirectory`、`renamePath`、`subscribePathChanges`、`clearError` 和可选的 `captureBytes`。同一会话同一路径共享一个缓冲、保存队列、冲突检查和 700 毫秒自动保存。`read(path)` 使用完整相对路径；`create(path, bytes, options)` 使用调用方给定的完整路径和字节；目录是否递归创建及相同内容重试由显式选项决定。项目存储不解码 UTF-8、不解释 JSON，也不根据扩展名推断格式。

`renamePath(fromPath, toPath)` 可以重命名任意项目内普通文件或目录；目标必须不存在。存储会先锁住两条路径及其祖先/后代操作，等待已接受的读取结束，并保存源路径下全部缓冲；保存或磁盘改名失败时保留旧路径和字节。成功后先同步发出 `{fromPath, toPath}` 路径变更通知，再一次性发布全部已打开文件的新路径。路径变更通知只用于同步其他插件持有的路径引用，不可取消或回滚改名；监听器异常会记录，不能中断已落盘操作。需要保留未保存正文的消费者必须在调用改名前先刷新正文编辑器并保存。

默认 `ProjectFile.bytes` 仍是只读冻结字节数组。调用方可在 `read`、`write` 的访问选项或 `create` 选项中显式设置 `preferByteView: true`，启用紧凑的 `ProjectByteView`；紧凑模式下快照提供 `byteView`，而兼容用的 `bytes` 数组只在被读取时才物化。`ProjectByteView` 暴露 `byteLength`、写入调用方 `Uint8Array` 的 `copyTo` 和逐字节比较用的 `equals`，不暴露内部可变缓冲区。该选项不改变字节内容，也不会自动迁移未选择它的调用方；当前 TXT 文档适配器选择此路径，Markdown、富文本和普通数组调用仍沿用原有表示。

`ProjectFiles.captureBytes?(data)` 是可选的无副作用辅助方法：它把调用方数据捕获为不可变 `ProjectByteView`，不会登记文件、修改缓冲或安排保存；文件服务停止后调用会抛出错误。当前内置项目存储在变更写入确实安装该 view 时会复用其身份，便于消费者验证刚写入的投影；若字节与现有缓冲相同，存储可能保留旧 view。替代实现无需保留对象身份，消费者在身份不同时仍须按字节精确比较。

桌面端的紧凑读取、创建和删除仍用 base64 内容命令传输字节。紧凑保存使用单个原始二进制 IPC 帧：UTF-8 JSON 元数据后依次放置新文件字节和保存前的精确字节基线，各自长度由元数据标明；宿主据此按原始字节执行现有路径检查和冲突保护。使用只读数组的旧保存调用继续走原有数组命令。传输方式不改变文件字节、单路径共享缓冲、保存队列或 700 毫秒自动保存；项目存储不负责选择 UTF-8 或其他文件编码。

统一字节命令是 `read_project_file`、`create_project_file`、`save_project_file`、`delete_project_file`、`list_project_directory`、`create_project_directory` 和 `rename_project_path`。宿主处理相对路径、符号链接和 expected-bytes 冲突保护，不知道文本或业务格式。documents 自己将正文数据解码为字符串；timeline 自己定义 UTF-8 与 `.lodestory/outline-design/timelines/<uuid>.json` 目录和 JSON 格式。存储契约只提供路径文件操作。

统一字节服务接入不会搬动或转码既有项目文件。旧文档文本读写命令已移除，正文和大纲消费者使用上述统一字节命令；`list_documents` 仅供工程文件树查询。配置与主题偏好仍保存在 `localStorage`，最近项目索引仍保存在应用配置目录；它们不由项目存储迁移。离开项目时，项目存储统一保存已接受的字节缓冲修改；保存失败会阻止离开并保留当前会话。

SDK 还定义两个窄事件，避免文档服务依赖文件树和正文界面：`documentCreateRequested` 携带 `{ sessionId, parentPath? }`，由当前提供新建交互的插件接收并展示自己的对话框；确认后再调用 `workspace.create`。`documentRevealRequested` 携带 `{ sessionId, documentId }`，由正文插件核对当前会话并显示对应文档；工程管理插件也监听它来同步文件树选择。文档插件在成功打开或创建文档、以及保存失败需要定位该文档时发布显示请求。事件监听失败会被报告，但不会撤销已提交的文档数据操作。

项目存储插件作为工作台参与者，在每次 `start(session)` 建立共享字节文件服务；离开时锁定修改、排空已接受的操作并保存所有内容。项目结束且视图已停止使用后才释放共享缓冲。文档插件仍通过 `documentsKey` 管理打开项、选择和文档业务交互；工程管理插件仍负责目录树和新建对话框。详见[项目存储插件设计](../../文档/需求设计/项目存储插件.md)、[文档管理插件设计](../../文档/需求设计/文档管理插件.md)和[工程管理插件设计](../../文档/需求设计/工程管理插件.md)。

## 构建与打包

仓库根目录执行 `pnpm install` 后，可用以下命令构建和打包；输出为 ESM JavaScript 与 `.d.ts`：

```sh
pnpm build:sdk
pnpm --filter @lodestory/sdk pack
```

`packages/sdk` 也可单独执行 `npm install`、`npm run build`、`npm pack`。SDK 源码开发时，根目录另开终端运行 `pnpm dev:sdk`，持续更新应用使用的构建产物。

宿主与插件必须共享同一个 SDK 模块实例；插件独立打包时应将 `@lodestory/sdk` 及其子路径保留为外部依赖，避免复制共享 key。本版只提供同一 JavaScript realm 内共用的契约与 key，不负责动态发现/加载外部插件，也不提供跨 realm RPC 或沙箱。
