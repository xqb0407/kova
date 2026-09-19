mod about;
mod appearance;
mod backup;
mod browser;
mod browser_scripts;
mod data;
mod fs;
mod git;
mod gpu;
mod http;
mod logging;
mod notify;
mod pi_agent;
mod pty;
mod remote;
mod secret;
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
        // 窗口配置 visible:false——等 webview 首帧就绪（静态 HTML 的磨砂+云
        // 已可渲染）再显示，消除"窗口出现但内容未加载"的透明闪烁。
        // Finished 对每次导航都触发（刷新等），show 幂等无害。
        .on_page_load(|webview, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started if webview.label() == "main" => {
                // 主页面（重）加载开始即移除浏览器子 webview：原生层不随主页面
                // 重载销毁，否则刷新后旧页面悬浮在启动画面上（browser.rs）
                browser::destroy_for_reload(webview.app_handle());
            }
            tauri::webview::PageLoadEvent::Finished if webview.label() == "main" => {
                let _ = webview.window().show();
            }
            _ => {}
        })
        .manage(PiState::default())
        .manage(remote::RemoteState::default())
        .manage(browser::BrowserState::default())
        .setup(|app| {
            // 磁盘日志最先初始化（后续任何失败都能记到 app.log）
            logging::init(app.handle());
            // 待恢复备份换入：必须在任何存储打开之前（state.db / sessions 换新）
            match backup::apply_pending_restore(app.handle()) {
                Ok(Some(summary)) => log::info!("[backup] restore applied: {summary}"),
                Ok(None) => {}
                Err(e) => log::error!("[backup] pending restore failed: {e}"),
            }
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
            // 兜底：page load 事件异常时窗口会永远隐藏——5s 后无条件 show
            // （对已显示窗口调用幂等，无副作用）
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                    }
                });
            }
            // 恢复持久化的窗口背景效果（穿透高斯模糊等）
            appearance::restore(app.handle());
            // 恢复开发者模式（WebView DevTools）
            about::restore(app.handle());
            // 预热拉起 pi-agent sidecar：自动化调度器住在 sidecar 内，必须早于用户
            // 首条消息存活（否则 app 开着没聊过天时定时任务不会触发）。失败仅记日志，
            // 聊天链路仍会经 ensure_spawned 懒拉起重试。
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<PiState>();
                    if let Err(e) = pi_agent::ensure_spawned(&app_handle, &state).await {
                        log::error!("[pi_agent] warm start failed: {e}");
                    }
                });
            }
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
            remote::pi_remote_revoke,
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
            fs::fs_read_file_base64,
            fs::fs_mkdir,
            fs::fs_touch,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_reveal,
            fs::app_file_list,
            fs::app_file_preview,
            fs::app_file_delete,
            http::http_post,
            notify::notify_show,
            notify::notify_consume_pending_session,
            webhook::webhook_delivery_add,
            webhook::webhook_delivery_list,
            webhook::webhook_delivery_delete,
            webhook::webhook_delivery_prune,
            backup::backup_config_get,
            backup::backup_config_set,
            backup::backup_test,
            backup::backup_run,
            backup::backup_list_remote,
            backup::backup_download,
            backup::backup_delete_remote,
            backup::backup_restore,
            backup::backup_peek_header,
            backup::backup_restart_app
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
