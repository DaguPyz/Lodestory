use crate::{
    project_files::{ProjectDirectoryListing, ProjectFileRecord, ProjectFiles},
    project_index::ProjectError,
};
use std::path::Path;
use tauri::{AppHandle, Manager};

async fn with_project_files<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&ProjectFiles) -> Result<T, ProjectError> + Send + 'static,
) -> Result<T, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || action(app.state::<ProjectFiles>().inner()))
        .await
        .map_err(|error| {
            ProjectError::new(
                "project_file_operation_failed",
                format!("项目文件操作失败：{error}"),
            )
        })?
}

#[tauri::command]
pub async fn read_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ProjectFileRecord, ProjectError> {
    with_project_files(app, move |store| {
        store.read(Path::new(&project_path), &path)
    })
    .await
}

#[tauri::command]
pub async fn create_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes: Vec<u8>,
    create_parents: Option<bool>,
    accept_identical: Option<bool>,
) -> Result<ProjectFileRecord, ProjectError> {
    with_project_files(app, move |store| {
        store.create(
            Path::new(&project_path),
            &path,
            &bytes,
            create_parents.unwrap_or(false),
            accept_identical.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn save_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes: Vec<u8>,
    expected_bytes: Vec<u8>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.save(Path::new(&project_path), &path, &bytes, &expected_bytes)
    })
    .await
}

#[tauri::command]
pub async fn delete_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    expected_bytes: Vec<u8>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.delete(Path::new(&project_path), &path, &expected_bytes)
    })
    .await
}

#[tauri::command]
pub async fn list_project_directory(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ProjectDirectoryListing, ProjectError> {
    with_project_files(app, move |store| {
        store.list_directory(Path::new(&project_path), &path)
    })
    .await
}

#[tauri::command]
pub async fn create_project_directory(
    app: AppHandle,
    project_path: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.create_directory(Path::new(&project_path), &path, recursive.unwrap_or(false))
    })
    .await
}
