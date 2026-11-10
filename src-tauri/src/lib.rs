#[cfg(any(not(feature = "desktop-e2e"), test))]
mod app_config;
mod app_tasks;
mod asset_tasks;
mod background_tasks;
mod document_commands;
mod documents;
mod project_commands;
mod project_file_commands;
mod project_files;
mod project_index;
mod system_fonts;
mod native_process;
mod native_library;

#[cfg(all(feature = "desktop-e2e", not(debug_assertions)))]
compile_error!("desktop-e2e is restricted to debug builds");

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(app_tasks::create()?);
            let directory = app.path().app_config_dir()?;
            #[cfg(not(feature = "desktop-e2e"))]
            {
                let legacy = app.path().config_dir()?.join("com.lodestory.app");
                app_config::migrate_legacy_directory(&directory, &legacy)?;
            }
            let path = directory.join(project_index::INDEX_FILENAME);
            app.manage(project_index::ProjectIndex::new(path));
            app.manage(documents::Documents::default());
            app.manage(project_files::ProjectFiles::default());
            app.manage(std::sync::Arc::new(native_process::NativeProcesses::default()));
            app.manage(std::sync::Arc::new(native_library::NativeLibraries::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            background_tasks::run_background_task,
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
            native_process::native_process_start,
            native_process::native_process_read,
            native_process::native_process_write,
            native_process::native_process_wait,
            native_process::native_process_abort_start,
            native_library::native_library_open,
            native_library::native_library_ready,
            native_library::native_library_call,
            native_library::native_library_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
