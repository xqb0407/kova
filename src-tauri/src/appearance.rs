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
            eprintln!("[appearance] {e}");
        }
    }
}
