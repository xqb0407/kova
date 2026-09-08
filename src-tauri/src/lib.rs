mod pi_agent;
mod store;

use pi_agent::PiState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .manage(PiState::default())
        .setup(|app| {
            // SQLite KV 存储（workspace 等应用状态）
            store::init(app.handle())
                .map_err(|e| eprintln!("[store] init failed: {e}"))
                .ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_agent::pi_prompt,
            pi_agent::pi_abort,
            pi_agent::pi_reset,
            pi_agent::pi_request,
            store::kv_get,
            store::kv_set,
            store::kv_delete
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<PiState>() {
                    pi_agent::kill_on_exit(&state);
                }
            }
        });
}
