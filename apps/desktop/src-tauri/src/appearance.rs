//! 外观设置：窗口背景材质（穿透高斯模糊）。
//! 使用 Tauri 2 内置 window effects（Windows 的 Acrylic/Mica、macOS 的系统材质），
//! 无需第三方插件；选择持久化于 SQLite kv，应用启动时在 setup 中恢复。
//! 生效前提：窗口 transparent:true（已在 tauri 配置中），前端根层（body）透明露出材质。

use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect as WindowEffect;
use tauri::{Manager, WebviewWindow};

use crate::store;

pub const KV_KEY: &str = "appearance.effect";

/// 规范化参数：空/none 归一为 None（不透明）
fn normalize(effect: Option<&str>) -> Option<&str> {
    effect.filter(|s| !s.is_empty() && *s != "none")
}

/// 效果名 → 当前平台支持的窗口效果。macOS 无 Acrylic/Mica，就近映射为系统材质。
fn effect_for(name: &str) -> Option<WindowEffect> {
    let macos = cfg!(target_os = "macos");
    match name {
        "acrylic" => Some(if macos {
            WindowEffect::Sidebar
        } else {
            WindowEffect::Acrylic
        }),
        "mica" => Some(if macos {
            WindowEffect::UnderWindowBackground
        } else {
            WindowEffect::Mica
        }),
        _ => None,
    }
}

/// 应用效果到窗口（不涉及持久化），命令与启动恢复共用
pub fn apply(window: &WebviewWindow, effect: Option<&str>) -> Result<(), String> {
    let cfg = normalize(effect)
        .and_then(effect_for)
        .map(|e| WindowEffectsConfig {
            effects: vec![e],
            state: None,
            radius: None,
            color: None,
        });
    window
        .set_effects(cfg)
        .map_err(|e| format!("failed to set window effects: {e}"))
}

/// 同步 webview 表面透明度：WebView2 表面带 alpha（transparent:true）时
/// ClearType 亚像素渲染被禁用，整窗文字退化为灰度抗锯齿——比浏览器
/// （不透明表面）细/虚，即"字体很奇怪"的根因。材质开启时表面必须保持
/// 透明（模糊要透出来，灰度 AA 是材质的代价）；材质关闭时表面恢复
/// 不透明拿回 ClearType。仅动 webview 的 DefaultBackgroundColor，
/// 不碰窗口背景画刷（避免干扰材质合成）。
/// 注意：开屏（BootSplash）期间须保持透明（body 透明露出桌面），所以
/// 材质关闭→不透明的翻转由前端在开屏结束时调 sync_webview_surface 触发，
/// 这里不做启动时的自动判断。
fn apply_webview_surface(app: &tauri::AppHandle, effect: Option<&str>) {
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let color = tauri::utils::config::Color(
        255,
        255,
        255,
        if effect.is_some() { 0 } else { 255 },
    );
    if let Err(e) = webview.set_background_color(Some(color)) {
        log::warn!("[appearance] failed to set webview background color: {e}");
    }
}

/// 开屏动画结束时由前端调用：按当前材质状态翻转表面透明度
/// （材质关闭 → 不透明恢复 ClearType）
#[tauri::command]
pub fn sync_webview_surface(app: tauri::AppHandle) -> Result<(), String> {
    let effect = store::kv_get_global(&app, KV_KEY).unwrap_or(None);
    apply_webview_surface(&app, effect.as_deref());
    Ok(())
}

/// 设置并持久化窗口背景效果。effect: "acrylic" | "mica" | None/"none"（不透明）。
#[tauri::command]
pub fn set_window_effect(window: WebviewWindow, effect: Option<String>) -> Result<(), String> {
    let name = normalize(effect.as_deref());
    if let Some(n) = name {
        if effect_for(n).is_none() {
            return Err(format!("unsupported window effect: {n}"));
        }
    }
    apply(&window, name)?;
    // 材质开→表面透明 / 材质关→表面不透明（恢复 ClearType）
    apply_webview_surface(window.app_handle(), name);
    let app = window.app_handle().clone();
    match name {
        Some(n) => store::kv_set_global(&app, KV_KEY, n)?,
        None => store::kv_delete_global(&app, KV_KEY)?,
    }
    Ok(())
}

/// 启动恢复：读取持久化设置并应用（失败不阻塞启动）
pub fn restore(app: &tauri::AppHandle) {
    let effect = store::kv_get_global(app, KV_KEY).unwrap_or(None);
    if effect.is_none() {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = apply(&win, effect.as_deref()) {
            log::warn!("[appearance] {e}");
        }
    }
}
