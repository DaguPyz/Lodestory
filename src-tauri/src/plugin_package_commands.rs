use crate::plugin_packages::{Compatibility, ImportedPackage, PluginPackages};
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn pick_plugin_package(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择插件包")
            .set_parent(&window)
            .add_filter("插件包", &["zip"])
            .blocking_pick_file()
            .map(|selected| {
                let path = selected
                    .into_path()
                    .map_err(|error| format!("所选文件路径无效：{error}"))?;
                path.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "所选文件路径无法表示，请选择其他文件。".to_owned())
            })
            .transpose()
    })
    .await
    .map_err(|error| format!("打开文件选择器失败：{error}"))?
}

#[tauri::command]
pub async fn list_plugin_packages(app: AppHandle) -> Result<Vec<ImportedPackage>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<PluginPackages>().list())
        .await
        .map_err(|error| format!("读取插件记录失败：{error}"))?
}

#[tauri::command]
pub async fn import_plugin_package(
    app: AppHandle,
    path: String,
    compatibility: Compatibility,
) -> Result<ImportedPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<PluginPackages>()
            .import(Path::new(&path), &compatibility)
    })
    .await
    .map_err(|error| format!("导入插件包失败：{error}"))?
}
