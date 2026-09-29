use crate::{
    documents::{Document, Documents, TreeEntry},
    project_index::ProjectError,
};
use std::path::Path;
use tauri::{AppHandle, Manager};

async fn with_documents<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&Documents) -> Result<T, ProjectError> + Send + 'static,
) -> Result<T, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || action(app.state::<Documents>().inner()))
        .await
        .map_err(|error| {
            ProjectError::new(
                "document_operation_failed",
                format!("文档操作失败：{error}"),
            )
        })?
}

#[tauri::command]
pub async fn list_documents(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<TreeEntry>, ProjectError> {
    with_documents(app, move |store| store.list(Path::new(&project_path))).await
}

#[tauri::command]
pub async fn create_document(
    app: AppHandle,
    project_path: String,
    parent_path: String,
    name: String,
) -> Result<Document, ProjectError> {
    with_documents(app, move |store| {
        store.create(Path::new(&project_path), &parent_path, &name)
    })
    .await
}

#[tauri::command]
pub async fn read_document(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<Document, ProjectError> {
    with_documents(app, move |store| {
        store.read(Path::new(&project_path), &path)
    })
    .await
}

#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    project_path: String,
    path: String,
    content: String,
    expected_content: String,
) -> Result<(), ProjectError> {
    with_documents(app, move |store| {
        store.save(Path::new(&project_path), &path, &content, &expected_content)
    })
    .await
}
