# UI 插件

`createUiPlugin` 把页面导航和 React 根节点装配合并为一个插件，并提供 `uiKey`。它依赖 `configKey`，登记 SDK 导出的 `uiInitialPageConfig`；`pluginsReady` 时，在全部包装层准备完成后读取配置并启动首页。默认值 `null` 沿用第一个登记页面。生产应用由配置插件设置 `ui.initialPage`，app 只装配 `createUiPlugin()`；独立宿主或测试可以显式传入容器与 `rootOptions`。

公共生命周期类型位于 [`@lodestory/sdk`](../../../packages/sdk/src/Plugin.ts)，UI 能力与页面类型位于 [`@lodestory/sdk/ui`](../../../packages/sdk/src/ui.ts)。`createUiPlugin` 与 `pluginsReady` 仍是宿主运行时实现；SDK 目前只提供同一 JavaScript realm 内的契约，不提供运行中热登记 API。

启动到 `pluginsReady` 后，所有初始插件已完成登记。UI 插件先按包装层的 `order` 依次调用并等待可选的 `prepare` 回调，全部成功后才通过 `configKey` 读取 `uiInitialPageConfig`，再验证目标页面已登记。配置值为 `null` 时使用第一个登记页面。随后它按包装层的 `order` 组装 Provider 与通用页面容器，再创建一个 React root。数值较小的 `order` 位于外层。`ui.initialPage` 的生效方式为 `restart`：启动后修改配置只保存新值，不会立即导航；重新启动 UI 时才读取。页面调用 `openPage(id, params)` 切换并记录历史，页面收到自己的 `params`；也可以传入第三个参数 `{history: "reset"}`，经守卫批准后清空历史并切换，不把当前页加入历史，适合关闭项目后回到欢迎页。默认 `history: "push"` 保持原有行为。即使目标页和参数与当前相同，带历史的 reset 仍会经过守卫并清空历史；历史已空时则不产生导航。`back()` 返回上一页并恢复它的参数。导航方法都返回 `Promise<boolean>`，守卫拒绝或有导航正在处理时返回 `false`；无历史记录的 `back()` 返回 `true` 且不改变状态。同一页面传入不同参数也会经过导航守卫并记录历史。已访问页面继续留在树中，只隐藏非当前页面，因此切换时会保留其 React 组件实例和 Hook 状态。

插件可以在 `pluginsReady` 前通过 `registerNavigationGuard` 登记异步导航守卫。UI 按登记顺序调用 `prepare({from, to, kind})`；open 请求若指定了 `history: "reset"`，该字段也会传给守卫。守卫可返回 `true`、`false`，或返回带可选 `commit`、`cancel`、`complete` 的批准对象。显式返回 `false` 会取消导航；`prepare` 抛错时 UI 逆序调用已批准对象的 `cancel`，然后用原错误拒绝 Promise。全部批准后，UI 在一次 `flushSync` 中同步调用 `commit` 并更新路由；`commit` 必须同步且不抛错，若它抛错，UI 会逆序调用所有批准对象的 `cancel` 并拒绝 Promise，这些 `cancel` 必须能恢复自己已经提交的同步状态。React 完成这次视图更新后，UI 才等待各批准对象的 `complete`，让工作台可以在 `complete` 中释放旧项目会话资源。即使某个 `complete` 抛错，UI 仍会执行后续清理；全部完成后以 `UiNavigationCompleteError` 拒绝 Promise，并通过 `routeCommitted` 与 `errors` 说明路由已提交及清理错误。守卫在运行中被直接撤销或 UI 停用会使等待中的导航失效，迟到的批准只会被取消，不会切换页面；通过插件生命周期停用时，进行中的导航会阻止该守卫撤回。

`prepare` 用于渲染前准备资源，例如主题插件在所有配色登记后应用选择并等待原生窗口同步。回调失败会中止启动并回滚；等待期间若包装层被撤销或 UI 停用，不会继续创建根视图。该回调不能等待 UI 渲染，也不能依赖较晚执行的 `pluginsReady` 监听者。

页面、根包装层和守卫仍只允许在 `pluginsReady` 前登记。贡献插件须用 `context.track` 关联登记句柄，并保留它用于激活失败或 `deactivate` 清理。单插件停用时，内核先执行全部检查和保存准备，再撤回该插件的页面、守卫及布局贡献，最后释放插件服务；被撤回的当前页先经导航守卫切至其他插件的页面，失败则保留插件及其依赖。未激活页面可直接撤销；当前页面只能通过停用流程撤销。根包装层和 UI 根在运行中拒绝单独卸载，整窗停止在保存检查后卸载根视图。运行中新增贡献及外部插件加载尚未实现。

`error-ui` 插件通过 `errorUiKey` 提供稳定的 `ErrorBoundary` 错误边界和 `ErrorView`。UI 插件依赖该服务，并用 `ErrorBoundary` 包住根下的 Provider 与页面树；页面插件也可以在自己的页面内容周围使用 `ErrorBoundary`，让局部错误只替换对应页面内容。插件是否被卸载仍由运行时生命周期决定，错误边界只负责渲染错误视图。

如果 React 的错误没有被 `ErrorBoundary` 捕获并到达根的 `onUncaughtError`，UI 插件会在同一个 root 用内置的简单错误界面替换当前树，不卸载 root 或已激活插件。这个最后兜底只恢复显示，不定位或停用某个业务插件。若真正的启动过程失败（例如插件激活、包装层准备或 `createRoot` 失败），内核会先回滚已激活插件，启动 Promise 拒绝后 `main.tsx` 调用 UI 模块的 `showUiStartupError` 显示 DOM 兜底页；该模块自行查找 `#root`，若根容器不存在则只报告原始启动错误与回滚错误，不会因再次渲染失败而抛错。正常停止、边界内错误、根级错误恢复和启动失败因此走不同的处理路径。

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
            removePage = context.track(context.get(uiKey).registerPage({
                id: "settings",
                render: () => <ErrorBoundary><SettingsPage /></ErrorBoundary>,
            }));
        },
        deactivate() {
            const remove = removePage;
            removePage = undefined;
            remove?.();
        },
    };
}
```

应用通过 `welcome`、`workbench`、`settings` 三个插件分别登记欢迎页、编辑页和设置页，初始页面显式设为 `welcome`。页面之间的 `openPage` 与 `back` 统一等待导航守卫；工作台负责项目进入、离开与会话生命周期，UI 不直接调用文档业务。

欢迎页通过 `workbench.openProject` 进入项目；直接调用 UI 导航、返回和同页替换项目参数也会经过同一个工作台守卫。文档保存失败时保留原页面与会话；切到设置只暂时隐藏编辑内容；关闭后重开同一项目会创建新的会话 ID。

欢迎页和设置页共用的品牌区与应用导航由独立的 `navigation-layout` 插件呈现。两个页面插件分别通过 `navigationLayoutKey` 登记页面和导航元数据；布局插件负责品牌区、分组和顺序，点击入口时调用 `ui.openPage(id)`。页面身份、历史和守卫仍由 UI 插件管理；设置页自身的返回操作仍调用 `ui.back()`。`appPlugins` 静态装配默认实现，页面登记只在启动期进行。它与仅用于工作台编辑页的 `default-layout` 是不同职责，详细接口和生命周期见[应用导航布局插件说明](../navigation-layout/README.md)。

窗口外壳由 `window-shell` 插件通过 `windowShellKey` 提供。导航页和工作台声明该依赖，并用同一次激活期间身份稳定的 `View` 包装各自页面内容；导航页默认显示浏览器模拟标题栏，工作台传入 `showBrowserTitlebar={false}`。Tauri 窗口不显示模拟标题栏。UI 插件只装配已登记的页面，不拥有 `PageShell` 或窗口外壳样式；接入细节见[窗口外壳插件说明](../window-shell/README.md)。

编辑页内部布局由独立的 `default-layout` 插件通过 `@lodestory/sdk/layout` 提供。`workbench` 页面按会话挂载布局的 `View`；`project-storage` 按会话创建共享字节文件服务，`documents` 管理打开项与文档操作流程，`project-management` 登记工程树并提供新建交互，`body-editor` 登记正文和写作状态，`workbench-toolbar` 登记顶部工具栏。布局负责排列和通用显隐，专注模式作为工具栏行为由 `workbench-toolbar` 组合 `layout.show/hide` 实现。UI 不认识这些用途，也不依赖某种布局实现。协议与清理边界见[工作台插件设计](../../../文档/需求设计/工作台插件.md)、[工作台工具栏插件设计](../../../文档/需求设计/工作台工具栏插件.md)、[项目存储插件设计](../../../文档/需求设计/项目存储插件.md)、[布局插件设计](../../../文档/需求设计/布局插件.md)和[正文编辑插件设计](../../../文档/需求设计/正文编辑插件.md)。
