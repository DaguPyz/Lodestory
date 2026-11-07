use serde_json::Value;
use std::collections::HashMap;
use tauri::{ipc::Response, State};

pub type Task = fn(Value) -> Result<Vec<u8>, String>;

#[derive(Default)]
pub struct BackgroundTasks {
    tasks: HashMap<&'static str, Task>,
}

impl BackgroundTasks {
    pub fn register(&mut self, name: &'static str, task: Task) -> Result<(), String> {
        if self.tasks.contains_key(name) {
            return Err(format!("后台任务“{name}”重复登记。"));
        }
        self.tasks.insert(name, task);
        Ok(())
    }
}

#[tauri::command]
pub async fn run_background_task(
    state: State<'_, BackgroundTasks>,
    name: String,
    input: Value,
) -> Result<Response, String> {
    let task = *state
        .tasks
        .get(name.as_str())
        .ok_or_else(|| format!("后台任务“{name}”未登记。"))?;
    let bytes = tauri::async_runtime::spawn_blocking(move || task(input))
        .await
        .map_err(|error| format!("后台任务执行失败：{error}"))??;
    Ok(Response::new(bytes))
}
