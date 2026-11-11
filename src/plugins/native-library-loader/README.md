# 动态库加载插件 B

B 是内置插件，负责加载可信的本地动态库、调用其公开接口并协调退出。它不发现或安装插件包，也不加载插件前端。业务数据由动态库的拥有者管理；通用内核和原生桥接不认识具体业务。

## 使用

在插件的 `requires` 中声明 `nativeLibraryLoaderKey`，通过 `context.get` 获取服务。动态库路径须是本机绝对路径：

```ts
import {nativeLibraryLoaderKey} from "@lodestory/sdk/native-library-loader";

const loader = context.get(nativeLibraryLoaderKey);
const backend = await loader.load("/可信插件/后端动态库");
try {
  const result = await backend.call({
    requestId: "request-1", operation: "ping", schemaVersion: "1.0.0", params: {text: "你好"},
  });
  console.log(result);
} finally {
  await backend.close();
}
```

请求与结果的业务字段与 A 相同；两者使用各自的能力 key。外部插件加载插件根据清单自动选择 A 或 B，并向插件前端提供统一调用入口。

## 动态库协议

ABI v1 的函数签名、返回缓冲区所有权和失败约定见 [公开 C 头文件](../../../packages/sdk/native/lodestory_native_library.h)。动态库必须导出版本查询、初始化、调用、退出和释放返回缓冲区五个函数。库可用 Rust 编写，需导出符合 C 调用约定的函数，不能把 Rust `String`、`Vec` 或异常直接跨边界传递。

调用输入和输出是 UTF-8 JSON；输入包含 `type: "call"`、`requestId`、`operation`、`schemaVersion` 和 `params`。输出包含 `type: "response"`、相同的 `requestId`、`status` 及 `result` 或 `error`。每条消息最多 8 MiB，返回缓冲区由库分配并由库释放。

每个实例的初始化、调用和退出均在同一个原生后台线程串行执行。加载时校验 ABI 版本及入口；初始化失败时尝试清理部分实例，清理失败则保留可追踪状态并报告。

## 退出和边界

关闭时拒绝新调用，等待已有调用，要求动态库停止自己的后台任务并清理，然后释放库句柄。应用关闭会通过插件停止流程触发这一过程。关闭等待超过 30 秒会报告超时；重试等待仍在执行的原操作，不会强行卸载仍在使用的库。库明确拒绝退出时，只有它按 ABI 保持实例有效，才能安全重试退出；B 不再向该实例发起业务调用。

动态库与 Lodestory 同进程，严重错误可能导致整个应用崩溃；后台线程不能隔离崩溃，也无法安全强制中断卡住的库函数。加载前的库初始化代码也可能执行，因此只应加载可信的动态库。B 本身不提供沙箱或插件包管理。

测试用的 Rust 动态库位于 [tests/fixtures/native-library-d](../../../tests/fixtures/native-library-d/README.md)；跨平台使用前还需在对应平台验证。
