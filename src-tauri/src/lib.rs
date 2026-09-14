mod about;
mod appearance;
mod browser;
mod browser_scripts;
mod data;
mod fs;
mod git;
mod gpu;
mod http;
mod logging;
mod pi_agent;
mod pty;
mod remote;
mod store;
mod tool_exec;
mod webhook;

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
        .plugin(tauri_plugin_notification::init())
        .manage(PiState::default())
        .manage(remote::RemoteState::default())
        .manage(browser::BrowserState::default())
        .setup(|app| {
            // 磁盘日志最先初始化（后续任何失败都能记到 app.log）
            logging::init(app.handle());
            // 浏览器自动化（browser.rs）需要 AppHandle 全局入口
            browser::init(app.handle().clone());
            // SQLite KV 存储（workspace 等应用状态）
            match store::init(app.handle()) {
                Ok(()) => log::info!("[store] init ok"),
                Err(e) => log::error!("[store] init failed: {e}"),
            }
            // 主窗口在配置中标记 create:false——需先读硬件加速开关
            // （gpu.rs），再建窗以便把 --disable-gpu 传进 WebView2 参数
            if let Err(e) = gpu::create_windows(app.handle()) {
                log::error!("[gpu] create main window failed: {e}");
                return Err(e.into());
            }
            // 恢复持久化的窗口背景效果（穿透高斯模糊等）
            appearance::restore(app.handle());
            // 恢复开发者模式（WebView DevTools）
            about::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_agent::pi_prompt,
            pi_agent::pi_abort,
            pi_agent::pi_reset,
            pi_agent::pi_request,
            pi_agent::pi_attach,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            remote::pi_remote_start,
            remote::pi_remote_stop,
            remote::pi_remote_status,
            remote::pi_remote_refresh_code,
            appearance::set_window_effect,
            about::open_logs_dir,
            about::open_external,
            about::set_dev_mode,
            gpu::get_gpu_acceleration,
            gpu::set_gpu_acceleration,
            logging::frontend_log,
            logging::cleanup_logs,
            store::kv_get,
            store::kv_set,
            store::kv_delete,
            browser::browser_attach,
            browser::browser_detach,
            browser::browser_sync_bounds,
            browser::browser_open_devtools,
            browser::browser_viewport_set,
            browser::browser_viewport_get,
            git::git_probe,
            git::git_status,
            git::git_diff,
            git::git_show,
            git::git_worktree_read,
            git::git_log,
            git::git_log_graph,
            git::git_checkpoint_create,
            git::git_checkpoint_restore,
            git::git_stage,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            fs::fs_list_dir,
            fs::fs_read_file,
            http::http_post,
            webhook::webhook_delivery_add,
            webhook::webhook_delivery_list,
            webhook::webhook_delivery_delete,
            webhook::webhook_delivery_prune
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
