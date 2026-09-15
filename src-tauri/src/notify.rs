//! 带"点击直达会话"的系统通知。tauri-plugin-notification v2 桌面端是
//! notify-rust 的薄封装：show() 后即遗忘，点击回调只在移动端 builder 存在。
//! 可行的等价方案：发通知时记下"最近一条待打开会话"（带时间戳），点击通知
//! 卡片原生会激活应用 → 前端在窗口 focus 时调 consume 取走（30s 有效）并切会话。
//! 窗口最小化/隐藏时顺带 best-effort 唤回。dev 版通知归属 Terminal/PowerShell
//! （见 lib/popup.ts 头注释），点击不回 app，属已知平台限制，不影响生产。

use std::sync::Mutex;
use std::time::Instant;

/// 待消费的"通知 → 会话"：(session_id, 发出时刻)
static PENDING: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(30);

fn wake_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn notify_show(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let manager = app.notification();
    // macOS 首次会弹系统授权框（与 JS 路径同语义）；Windows 恒为 granted
    manager.request_permission().map_err(|e| e.to_string())?;
    let builder = manager.builder().title(&title).body(&body);
    builder.show().map_err(|e| e.to_string())?;
    if let Some(session_id) = session {
        if let Ok(mut guard) = PENDING.lock() {
            *guard = Some((session_id, Instant::now()));
        }
    }
    Ok(())
}

/// 窗口重新获得焦点时取走待打开会话（一次性；过期即作废）。
#[tauri::command]
pub fn notify_consume_pending_session(app: tauri::AppHandle) -> Option<String> {
    let session = {
        let Ok(mut guard) = PENDING.lock() else { return None };
        let entry = guard.take()?;
        (Instant::now() - entry.1 < PENDING_TTL).then_some(entry.0)
    };
    if session.is_some() {
        wake_main_window(&app);
    }
    session
}
