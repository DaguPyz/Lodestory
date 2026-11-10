# 独立程序加载插件 A

Lodestory 是由插件组成的应用。有些第三方插件除了前端页面，还有用 Rust 编写的独立后端程序。

为了方便说明，假设：

- **C** 是这样的第三方插件：它有一个独立运行的 Rust 后端，也可以有自己的前端页面。
- **A** 是 Lodestory 内置的加载插件，负责加载并运行 C 的 Rust 后端，让它能被调用。

最终目标是让 C 加载到 Lodestory 中并生效。A 负责其中的**后端加载和通信**；C 的前端还需要通过插件的页面登记机制接入。这两部分都接好，才能说带前端的 C 已完整接入。

## A 怎么工作

1. 启动 C 的 Rust 程序，等待它告诉 A「准备好了」。
2. C 的前端需要执行后端逻辑时，把请求交给 A；A 转发给 C 的后端，再把结果带回来。
3. 不再使用 C 的后端时，A 请求它清理资源并退出。

调用过程是：

```text
C 的前端 → A → C 的 Rust 程序 → A → C 的前端
```

**当前 A 已实现以上后端通信的基础能力，但还不能安装完整的 C，也不能加载 C 的前端页面。** 目前只用模拟消息测试过，尚未与真实的 C 联调。

## 怎么用

使用 A 的插件需要在 `requires` 中声明 `nativeProcessLoaderKey`，然后从 `context` 获取它。下面的路径和操作名只是例子：

```ts
import {nativeProcessLoaderKey} from "@lodestory/sdk/native-process-loader";

// 在插件的 activate(context) 中：
const loader = context.get(nativeProcessLoaderKey);
const backend = await loader.load("/插件目录/后端程序");

try {
  const response = await backend.call({
    requestId: "request-1",       // 这次请求的 ID
    operation: "getTimeline",    // 想让后端做什么
    schemaVersion: "1.0.0",      // 参数结构的版本
    params: {id: "timeline-1"},   // 传给后端的参数
  });

  // response.status 是 success 或 error
  console.log(response);
} finally {
  await backend.close();          // 用完后让后端退出
}
```

可以同时发出多个请求，但进行中的请求不能使用相同的 `requestId`。如果后端意外断开，A 会返回错误，不会自动重试。

## 后端程序要做什么

后端通过标准输入接收消息，通过标准输出返回消息：**每行一条 JSON**。启动完成后，先输出准备消息：

```json
{"type":"ready","protocolVersion":"1.0.0"}
```

之后按请求返回结果；收到退出请求时，清理资源、返回结果并结束进程。日志请写到标准错误输出，别混进标准输出。单条输入或输出最多 8 MiB。

启动和退出各等待最多 30 秒。退出等待超时后，A 会返回错误，但不会强制结束进程；后端稍后仍可能完成退出。

## 现在做到哪了

- A 已经能在桌面应用中启动程序、发送请求、接收结果和请求退出；目前只用模拟消息测试过，还没有真实的 C 联调。
- 目前还不能安装第三方插件包，也不能动态加载 C 的前端页面。
- 应用窗口关闭时，自动通知 A 退出后端的流程还没有接入；当前需要调用 `close()`。
- A 不会限制后端程序访问文件或网络，只应启动你信任的程序。
