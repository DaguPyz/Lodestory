use crate::project_index::{OpenedProject, ProjectError, ProjectIndex, RecentProject};
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

async fn with_index<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&ProjectIndex) -> Result<T, ProjectError> + Send + 'static,
) -> Result<T, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || action(app.state::<ProjectIndex>().inner()))
        .await
        .map_err(|error| ProjectError::new("operation_failed", format!("项目操作失败：{error}")))?
}

#[tauri::command]
pub async fn list_recent_projects(app: AppHandle) -> Result<Vec<RecentProject>, ProjectError> {
    with_index(app, ProjectIndex::list).await
}

#[tauri::command]
pub async fn open_project(app: AppHandle, path: String) -> Result<OpenedProject, ProjectError> {
    with_index(app, move |index| index.open(Path::new(&path))).await
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    parent_path: String,
    name: String,
) -> Result<OpenedProject, ProjectError> {
    with_index(app, move |index| {
        index.create(Path::new(&parent_path), &name)
    })
    .await
}

#[tauri::command]
pub async fn relocate_project(
    app: AppHandle,
    id: Uuid,
    path: String,
) -> Result<OpenedProject, ProjectError> {
    with_index(app, move |index| index.relocate(id, Path::new(&path))).await
}

#[tauri::command]
pub async fn remove_recent_project(
    app: AppHandle,
    id: Uuid,
) -> Result<Vec<RecentProject>, ProjectError> {
    with_index(app, move |index| index.remove(id)).await
}

#[tauri::command]
pub async fn pick_project_directory(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
) -> Result<Option<String>, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .set_parent(&window)
            .blocking_pick_folder()
            .map(|selected| {
                let path = selected.into_path().map_err(|error| {
                    ProjectError::new("invalid_path", format!("选择的目录路径无效：{error}"))
                })?;
                path.to_str().map(str::to_owned).ok_or_else(|| {
                    ProjectError::new(
                        "unsupported_path",
                        "目录路径无法表示为 UTF-8，请选择其他目录。",
                    )
                })
            })
            .transpose()
    })
    .await
    .map_err(|error| ProjectError::new("dialog_failed", format!("打开目录选择器失败：{error}")))?
}
