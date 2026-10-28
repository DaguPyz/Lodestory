mod app_config;
mod document_commands;
mod documents;
mod project_commands;
mod project_file_commands;
mod project_files;
mod project_index;
mod system_fonts;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            let legacy = app.path().config_dir()?.join("com.lodestory.app");
            app_config::migrate_legacy_directory(&directory, &legacy)?;
            let path = directory.join(project_index::INDEX_FILENAME);
            app.manage(project_index::ProjectIndex::new(path));
            app.manage(documents::Documents::default());
            app.manage(project_files::ProjectFiles::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            project_commands::list_recent_projects,
            project_commands::open_project,
            project_commands::create_project,
            project_commands::relocate_project,
            project_commands::remove_recent_project,
            project_commands::pick_project_directory,
            document_commands::list_documents,
            project_file_commands::read_project_file,
            project_file_commands::create_project_file,
            project_file_commands::save_project_file,
            project_file_commands::delete_project_file,
            project_file_commands::read_project_file_base64,
            project_file_commands::create_project_file_base64,
            project_file_commands::save_project_file_base64,
            project_file_commands::save_project_file_binary,
            project_file_commands::delete_project_file_base64,
            project_file_commands::list_project_directory,
            project_file_commands::create_project_directory,
            project_file_commands::rename_project_path,
            system_fonts::list_system_font_families,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
