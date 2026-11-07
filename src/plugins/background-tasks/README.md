# 后台任务插件

通过 `@lodestory/sdk/background-tasks` 提供任务执行能力。桌面端调用 Rust 任务登记表并在后台线程执行，返回字节或错误。任务代码由业务插件拥有，资产任务位于 `src-tauri/src/asset_tasks.rs`，内置任务在 `src-tauri/src/app_tasks.rs` 中静态装配。请求输入通过 Tauri 传递，输入转换本身仍有前端开销。

业务插件为浏览器环境登记同名备用实现并在停用时撤销。桌面任务失败时返回错误，由业务插件决定如何保留和重试数据。
