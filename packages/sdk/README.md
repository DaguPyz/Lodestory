# @lodestory/sdk

Lodestory 插件使用的共享契约包，提供插件生命周期类型、能力与事件 key，以及 UI 和主题服务契约。它不包含宿主实现。

## 导出入口

- `@lodestory/sdk`：`Plugin`、`PluginContext`、能力 key 与事件 key 类型和创建函数。
- `@lodestory/sdk/ui`：UI 服务类型与共享单例 `uiKey`。
- `@lodestory/sdk/theme`：主题服务、模式和快照类型与共享单例 `themeKey`。

## 生命周期与 key

宿主创建 `EngineCore` 并挂载插件时调用 `activate(context)`。插件在其中用 `provide` 注册声明过的能力，用 `get` 读取声明的依赖，用 `on` 订阅事件，也可用 `emit` 发布事件。卸载或激活失败时，宿主调用可选的 `deactivate()`，并撤销该插件的能力和订阅。

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
    removePage = ui.registerPage({
      id: "example",
      render: ({ params, active }) => <main hidden={!active}>{String(params ?? "")}</main>,
    });
  },
  deactivate() {
    removePage?.();
    removePage = undefined;
  },
};
```

主题插件和设置页共享 `themeKey`，由主题插件提供服务实现：

```ts
import { type Plugin } from "@lodestory/sdk";
import { themeKey } from "@lodestory/sdk/theme";

export const settingsPlugin: Plugin = {
  id: "example.settings",
  requires: [themeKey],
  provides: [],
  activate(context) {
    const theme = context.get(themeKey);
    theme.setMode("system");
    console.log(theme.getSnapshot().resolvedTheme);
  },
};
```

## 构建与打包

仓库根目录执行 `pnpm install` 后，可用以下命令构建和打包；输出为 ESM JavaScript 与 `.d.ts`：

```sh
pnpm build:sdk
pnpm --filter @lodestory/sdk pack
```

`packages/sdk` 也可单独执行 `npm install`、`npm run build`、`npm pack`。SDK 源码开发时，根目录另开终端运行 `pnpm dev:sdk`，持续更新应用使用的构建产物。

宿主与插件必须共享同一个 SDK 模块实例；插件独立打包时应将 `@lodestory/sdk` 及其子路径保留为外部依赖，避免复制共享 key。本版只提供同一 JavaScript realm 内共用的契约与 key，不负责动态发现/加载外部插件，也不提供跨 realm RPC 或沙箱。
