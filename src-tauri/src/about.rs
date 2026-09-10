//! 关于页能力：打开日志目录/外部链接（系统默认处理器）、开发者模式（WebView DevTools）。
//! 前端未引入 plugin-shell/plugin-fs 的 JS 包，故统一走自定义命令 + std::process 打开，
//! 避免为此新增 npm 依赖。开发者模式持久化于 SQLite kv（与外观效果同一套恢复机制）。

use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::store;

pub const DEV_KV_KEY: &str = "dev.mode";

/// 用系统默认处理器打开文件/目录/URL：macOS `open`，Windows `start`，Linux `xdg-open`
fn open_with_default(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(target);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", target]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    cmd.spawn().map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

/// 打开（不存在则创建）应用日志目录，并返回其路径供界面展示
#[tauri::command]
pub fn open_logs_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().into_owned();
    open_with_default(&path)?;
    Ok(path)
}

/// 在系统浏览器打开反馈等外部链接（仅限 http(s)/mailto，拒绝任意协议）
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:"))
    {
        return Err("仅允许打开 http(s)/mailto 链接".into());
    }
    open_with_default(&url)
}

/// 开/关 WebView 开发者工具并持久化（release 构建依赖 tauri 的 devtools feature）
#[tauri::command]
pub fn set_dev_mode(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    if enabled {
        window.open_devtools();
    } else {
        window.close_devtools();
    }
    let app = window.app_handle().clone();
    if enabled {
        store::kv_set_global(&app, DEV_KV_KEY, "1")?;
    } else {
        store::kv_delete_global(&app, DEV_KV_KEY)?;
    }
    Ok(())
}

/// 启动恢复：开发者模式开启时自动唤起 DevTools（失败不阻塞启动）
pub fn restore(app: &tauri::AppHandle) {
    let enabled = store::kv_get_global(app, DEV_KV_KEY)
        .ok()
        .flatten()
        .is_some_and(|v| v == "1");
    if !enabled {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        win.open_devtools();
    }
}
