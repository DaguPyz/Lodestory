use crate::{
    documents::{Documents, TreeEntry},
    project_index::ProjectError,
};
use std::path::Path;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn list_documents(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<TreeEntry>, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Documents>().list(Path::new(&project_path))
    })
    .await
    .map_err(|error| {
        ProjectError::new(
            "document_operation_failed",
            format!("文档操作失败：{error}"),
        )
    })?
}
