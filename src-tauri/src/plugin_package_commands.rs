use crate::plugin_packages::{Compatibility, ImportedPackage, PluginPackages, PreparedPackage};
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

#[tauri::command]
pub async fn prepare_plugin_package(
    app: AppHandle,
    id: String,
    compatibility: Compatibility,
) -> Result<PreparedPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<PluginPackages>().prepare(&id, &compatibility)
    })
    .await
    .map_err(|error| format!("检查插件包失败：{error}"))?
}

#[tauri::command]
pub async fn set_plugin_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<PluginPackages>().set_enabled(&id, enabled)
    })
    .await
    .map_err(|error| format!("保存插件状态失败：{error}"))?
}

#[tauri::command]
pub fn release_plugin_assets(app: AppHandle, id: String) {
    app.state::<PluginPackages>().release_assets(&id);
}

pub fn asset_response(app: &AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(path.trim_start_matches('/')).decode_utf8();
    let result = decoded
        .map_err(|_| "插件资源路径无效。".to_owned())
        .and_then(|path| {
            let (id, file) = path.split_once('/').ok_or("插件资源路径无效。")?;
            app.state::<PluginPackages>()
                .asset(id, file)
                .map(|bytes| (file.to_owned(), bytes))
        });
    let mut response = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    match result {
        Ok((file, bytes)) => {
            let content_type = match file
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "js" | "mjs" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "woff" => "font/woff",
                "woff2" => "font/woff2",
                "ttf" => "font/ttf",
                "otf" => "font/otf",
                _ => "application/octet-stream",
            };
            response = response.header("Content-Type", content_type);
            response.body(bytes).expect("valid asset response")
        }
        Err(error) => response
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(error.into_bytes())
            .expect("valid error response"),
    }
}
