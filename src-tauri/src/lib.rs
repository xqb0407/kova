mod appearance;
mod data;
mod pi_agent;
mod remote;
mod store;
mod tool_exec;

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
        .manage(remote::RemoteState::default())
        .setup(|app| {
            // SQLite KV 存储（workspace 等应用状态）
            store::init(app.handle())
                .map_err(|e| eprintln!("[store] init failed: {e}"))
                .ok();
            // 恢复持久化的窗口背景效果（穿透高斯模糊等）
            appearance::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_agent::pi_prompt,
            pi_agent::pi_abort,
            pi_agent::pi_reset,
            pi_agent::pi_request,
            remote::pi_remote_start,
            remote::pi_remote_stop,
            remote::pi_remote_status,
            remote::pi_remote_refresh_code,
            appearance::set_window_effect,
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
                remote::stop_on_exit(app_handle);
            }
        });
}
