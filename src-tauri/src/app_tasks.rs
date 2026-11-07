use crate::{asset_tasks, background_tasks::BackgroundTasks};

/** Select the built-in Rust task contributions. */
pub fn create() -> Result<BackgroundTasks, String> {
    let mut tasks = BackgroundTasks::default();
    tasks.register(
        asset_tasks::VALIDATE_AND_ENCODE,
        asset_tasks::validate_and_encode,
    )?;
    Ok(tasks)
}
