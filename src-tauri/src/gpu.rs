//! Chrome(WebView2) 硬件加速开关。
//!
//! 关闭后为 WebView2 追加 `--disable-gpu`，改用软件渲染，规避部分显卡/驱动
//! 导致的白屏、闪退、渲染异常。浏览器参数只在 WebView2 环境创建时读取，而
//! tauri 对配置中 create:true 的窗口会在 setup 钩子**之前**自动建窗（见
//! tauri app::setup），届时再设置参数为时已晚——因此主窗口在 tauri.conf.json
//! 标记 `"create": false`，改由本模块在 setup 内、store 就绪后从同一份窗口
//! 配置手动创建，开关值得以在建窗前落进参数。修改需重启应用生效。
//!
//! 持久化于 SQLite kv：`gpu.disabled = "1"` 表示已关闭，无行 = 开启
//! （与 dev.mode 同一套「命令写 kv + 启动读 kv」机制）。非 Windows 平台
//! （WKWebView/WebKitGTK）无 Chromium 参数概念，开关保存但不生效。

use tauri::{AppHandle, WebviewWindowBuilder};

use crate::store;

pub const DISABLED_KV_KEY: &str = "gpu.disabled";

/// wry 在 Windows 上默认的 WebView2 参数；手动覆盖 additional_browser_args
/// 时默认串会被顶掉，需原样保留再追加。
#[cfg(target_os = "windows")]
const DEFAULT_WEBVIEW2_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 已保存的开关状态：缺省/读库失败均视为开启（与首次运行行为一致）
pub fn is_acceleration_enabled(app: &AppHandle) -> bool {
    store::kv_get_global(app, DISABLED_KV_KEY)
        .ok()
        .flatten()
        .map_or(true, |v| v != "1")
}

/// 创建配置中标记 `"create": false` 的窗口（即主窗口）。
/// 必须在 setup 钩子内、store::init 之后调用。
pub fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    for wcfg in app.config().app.windows.iter().filter(|w| !w.create) {
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut builder = WebviewWindowBuilder::from_config(app, wcfg)?;
        #[cfg(target_os = "windows")]
        if !is_acceleration_enabled(app) {
            builder = builder
                .additional_browser_args(&format!("{DEFAULT_WEBVIEW2_ARGS} --disable-gpu"));
        }
        builder.build()?;
    }
    Ok(())
}

/// 查询已保存的硬件加速开关（默认开启）
#[tauri::command]
pub fn get_gpu_acceleration(app: AppHandle) -> bool {
    is_acceleration_enabled(&app)
}

/// 设置硬件加速开关并持久化。只落库不改当前进程——WebView2 环境
/// 参数创建后不可变，需重启应用生效（设置页文案已注明）。
#[tauri::command]
pub fn set_gpu_acceleration(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        store::kv_delete_global(&app, DISABLED_KV_KEY)?;
    } else {
        store::kv_set_global(&app, DISABLED_KV_KEY, "1")?;
    }
    Ok(())
}
