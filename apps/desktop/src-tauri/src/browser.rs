//! 面板内置浏览器的宿主侧：子 webview 生命周期、定位与 agent 自动化原语。
//!
//! 渲染载体：unstable 多 webview 在主窗口内挂一个 label 为 "browser-panel"
//! 的子 webview，替代原先的 iframe（跨域 iframe 无法注入脚本，agent 没法驱动）。
//! React 侧（browser-view.tsx）测量占位 div 经 browser_sync_bounds 同步物理
//! 像素 bounds；页面导航经 on_navigation / on_page_load emit "browser:navigated"
//! 回前端维护地址栏与 tab 记录。
//!
//! agent 驱动：sidecar 的 browser_* 工具经 hostdb（host_query）进
//! tool_exec::handle_tool → run_tool，在本模块 eval_with_callback 驱动同一个
//! webview（导航/点击/输入/滚动/提取渲染后的 DOM 快照），用户在面板里实时
//! 看到 agent 的操作。控制回路不经过前端——前端只负责创建/显示/定位。
//!
//! 坐标系：bounds 为窗口客户区物理像素（子 webview 相对父窗口客户区定位，
//! React 视口 == 客户区，两端一致）。数据目录独立于主会话（browser-panel 子目录）。

use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, State, Url,
    WebviewUrl, Wry,
};

use crate::browser_scripts::{
    BACK_JS, CLICK_JS_TEMPLATE, RESOLVE_JS, SCROLL_JS_TEMPLATE, SNAPSHOT_JS, STATE_JS,
    TYPE_JS_TEMPLATE,
};
use crate::tool_exec::CancelGuard;

/// 子 webview 的 label（同窗口内唯一）
const BROWSER_LABEL: &str = "browser-panel";

/// navigate 总等待上限；click/type 后的稳定等待更短
const NAVIGATE_SETTLE: Duration = Duration::from_secs(30);
const ACTION_SETTLE: Duration = Duration::from_secs(10);
/// 单次 eval 的超时（页面卡死时兜底）
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

/// AppHandle 全局注册：host_query 的分发链（data.rs → tool_exec）拿不到
/// AppHandle，browser 自动化经此取用（lib.rs setup 时写入）
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// 视口模式：填满面板占位区，或固定逻辑尺寸（CSS px，响应式调试）
#[derive(Clone, Copy, Debug, PartialEq, Default)]
enum ViewportMode {
    #[default]
    Fill,
    Fixed { width: f64, height: f64 },
}

/// 管理态：frame = React 同步的 webview 目标矩形；container = 占位容器矩形
/// （自由尺寸钳制/居中用，面板未挂载时 AI resize 兜底算位）；viewport = 视口
/// 模式。webview 句柄按 label 现取，不驻留。
#[derive(Default)]
pub struct BrowserState {
    frame: Mutex<Option<Rect>>,
    container: Mutex<Option<Rect>>,
    viewport: Mutex<ViewportMode>,
}

/// 动作闸门：一次 agent 动作（导航等待+快照）是多步 eval，需要跨步互斥。
/// try_lock 失败 = 另一线程（可能是别的会话）的 browser 动作在飞，明确拒绝。
static ACTION_GATE: Mutex<()> = Mutex::new(());

fn parse_web_url(s: &str) -> Result<Url, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err("url is required".into());
    }
    let u = Url::parse(t).map_err(|_| format!("invalid url: {t}"))?;
    match u.scheme() {
        // file:// 一并放行：产物「浏览器预览」直接加载工作区里的本地 HTML。
        // 代价：agent 的 browser_navigate 也能导航本地文件（用户已确认接受）。
        "http" | "https" | "file" => Ok(u),
        _ => Err(format!("only http/https/file urls are supported: {t}")),
    }
}

/// ref/方向进 JS 字符串字面量的安全转义（值只出现在 "" 内，转义引号与反斜杠即可）
fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

/* ------------------------------ webview 生命周期 ------------------------------ */

/// 创建子 webview（创建后隐藏：由前端 attach 显示，agent 自动创建时面板可能还没开）
fn create_webview(
    app: &AppHandle,
    state: &BrowserState,
    url: Url,
    default_bounds: Option<Rect>,
) -> Result<(), String> {
    if app.get_webview(BROWSER_LABEL).is_some() {
        return Ok(());
    }
    let window = app.get_window("main").ok_or("main window not found")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-panel");
    let builder = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(url))
        .data_directory(dir)
        // 主框架导航一律放行，只用于把新地址提前推给前端（finished 阶段再补标题）
        .on_navigation(|new_url| {
            emit_navigated(new_url.as_str().to_string(), "started", None);
            true
        })
        .on_page_load(|wv, payload| {
            if payload.event() == PageLoadEvent::Finished {
                emit_navigated(payload.url().to_string(), "finished", None);
                // 标题不在 payload 里，load 完成后异步取一次再推
                let _ = wv.eval_with_callback(STATE_JS, move |res| {
                    if let Ok(v) = serde_json::from_str::<Value>(&res) {
                        emit_navigated(
                            v["url"].as_str().unwrap_or("").to_string(),
                            "title",
                            Some(v["title"].as_str().unwrap_or("").to_string()),
                        );
                    }
                });
            }
        })
        // 注：tauri 2.11 未暴露 new_window_req_handler，弹窗走平台默认（WKWebView 默认不建新窗口）
        ;
    let bounds = state
        .frame
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .unwrap_or_else(|| default_bounds.unwrap_or_else(|| fallback_bounds(&window)));
    window
        .add_child(
            builder,
            Position::from(bounds.position),
            Size::from(bounds.size),
        )
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.hide();
    }
    Ok(())
}

/// 关掉面板 webview 并等它真正从注册表里消失。
/// `Webview::close()` 只是发起关闭，注销在平台侧异步完成；不等到 `get_webview`
/// 返回 None 就重建的话，`create_webview` 的"已存在就跳过"守卫会让我们拿着
/// 同一个正在消亡的句柄重试一遍，白等一个 NAVIGATE_SETTLE。
fn close_and_wait_unregistered(app: &AppHandle, max: Duration) {
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.close();
    }
    let deadline = Instant::now() + max;
    while Instant::now() < deadline {
        if app.get_webview(BROWSER_LABEL).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    log::warn!("[browser] panel webview still registered after close; recreate may be a no-op");
}

/// 落地页与请求页是否算同一个。只容忍尾斜杠这种纯规范化差异——http→https
/// 升级、带 query 的重定向都算"落到别处去了"，必须让 agent 知道。
fn same_page(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> &str {
        s.trim().trim_end_matches('/')
    }
    !norm(a).is_empty() && norm(a) == norm(b)
}

/// 物理像素 bounds 辅助：Rect{position,size}，子 webview 相对父窗口客户区定位
fn physical_rect(x: i32, y: i32, width: u32, height: u32) -> Rect {    Rect {
        position: Position::Physical(PhysicalPosition::new(x, y)),
        size: Size::Physical(PhysicalSize::new(width, height)),
    }
}

/// 还没同步过 bounds 时的兜底定位：主窗口右半屏
fn fallback_bounds(window: &tauri::Window<Wry>) -> Rect {
    let size = window.inner_size().unwrap_or(PhysicalSize::new(1600, 900));
    physical_rect((size.width / 2) as i32, 0, size.width / 2, size.height)
}

fn emit_navigated(url: String, phase: &str, title: Option<String>) {
    let payload = json!({ "url": url, "phase": phase, "title": title });
    if let Some(app) = APP.get() {
        let _ = app.emit_to("main", "browser:navigated", payload);
    }
}

/* ------------------------------ 前端命令 ------------------------------ */

/// 前端打开/激活浏览器 tab 时调用：显示（不存在则创建），可选导航到 url。
/// url 与当前一致时跳过导航（agent 创建后的 attach 不触发二次加载）；
/// force=true 强制导航（刷新按钮）。
#[tauri::command]
pub async fn browser_attach(
    app: AppHandle,
    state: State<'_, BrowserState>,
    url: Option<String>,
    force: Option<bool>,
) -> Result<(), String> {
    let parsed = match url {
        Some(u) if !u.trim().is_empty() => Some(parse_web_url(&u)?),
        _ => None,
    };
    match app.get_webview(BROWSER_LABEL) {
        Some(wv) => {
            if let Some(u) = parsed {
                let skip_same = !force.unwrap_or(false);
                let current = if skip_same {
                    current_page(&wv)
                        .await
                        .ok()
                        .and_then(|v| v["url"].as_str().map(String::from))
                } else {
                    None
                };
                if current.as_deref() != Some(u.as_str()) {
                    wv.navigate(u).map_err(|e| e.to_string())?;
                }
            }
            wv.show().map_err(|e| e.to_string())?;
        }
        None => {
            let u = parsed.ok_or("browser_attach: url required to create the panel webview")?;
            create_webview(&app, &state, u, None)?;
            if let Some(wv) = app.get_webview(BROWSER_LABEL) {
                let _ = wv.show();
            }
        }
    }
    Ok(())
}

/// tab 切走/面板收起时隐藏（保留 webview 与页面状态）；destroy=true 关闭并移除子 webview
#[tauri::command]
pub fn browser_detach(app: AppHandle, destroy: Option<bool>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        if destroy.unwrap_or(false) {
            wv.close().map_err(|e| format!("failed to close browser webview: {e}"))?;
        } else {
            let _ = wv.hide();
        }
    }
    Ok(())
}

/// 主 webview 开始（重新）加载时移除子 webview：原生子 webview 不随主页面
/// 重载销毁，若不在此处移除，刷新后旧页面会悬浮在旧 bounds 上盖住启动画面
/// （前端 React 挂载后才清，中间隔数秒）。lib.rs 的全局 on_page_load 在
/// Started 阶段调用本函数——移除时机最早、无闪烁。无子 webview 时幂等无害。
pub fn destroy_for_reload(app: &AppHandle) {
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.close();
        log::info!("[browser] main webview reload: destroyed child webview");
    }
}

/// React 占位区的物理像素 bounds 同步（ResizeObserver / resize / scroll 驱动）。
/// frame = webview 目标矩形；container = 占位容器矩形（视口钳制/居中基准）。
#[tauri::command]
pub fn browser_sync_bounds(
    app: AppHandle,
    state: State<'_, BrowserState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    cx: Option<i32>,
    cy: Option<i32>,
    cwidth: Option<i32>,
    cheight: Option<i32>,
) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Ok(()); // 不可见（面板收起/尺寸 0）：不更新，避免定位到废位置
    }
    let rect = physical_rect(x, y, width.max(1) as u32, height.max(1) as u32);
    *state.frame.lock().unwrap_or_else(|e| e.into_inner()) = Some(rect);
    if let (Some(cx), Some(cy), Some(cw), Some(ch)) = (cx, cy, cwidth, cheight) {
        if cw > 0 && ch > 0 {
            *state.container.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(physical_rect(cx, cy, cw as u32, ch as u32));
        }
    }
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        wv.set_bounds(rect).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------ 视口尺寸切换 ------------------------------ */

fn viewport_payload(vp: ViewportMode) -> Value {
    match vp {
        ViewportMode::Fill => json!({ "mode": "fill", "width": null, "height": null }),
        ViewportMode::Fixed { width, height } => {
            json!({ "mode": "fixed", "width": width, "height": height })
        }
    }
}

fn set_viewport(app: &AppHandle, state: &BrowserState, vp: ViewportMode) {
    *state.viewport.lock().unwrap_or_else(|e| e.into_inner()) = vp;
    if let Some(a) = APP.get() {
        let _ = a.emit_to("main", "browser:viewport", viewport_payload(vp));
    }
    // Fill 的落位由 React 帧驱动；Fixed 在 React 未挂载时（面板收起、AI 调用）
    // 由宿主直接按容器算位落 webview，保证页面真的按新尺寸重排
    let _ = apply_viewport(app, state);
}

/// Fixed 视口的物理矩形：容器内逻辑钳制 + 居中（React 侧用 CSS 表达同一布局）
fn apply_viewport(app: &AppHandle, state: &BrowserState) -> Result<(), String> {
    let vp = *state.viewport.lock().unwrap_or_else(|e| e.into_inner());
    let ViewportMode::Fixed { width, height } = vp else {
        return Ok(());
    };
    let Some(wv) = app.get_webview(BROWSER_LABEL) else {
        return Ok(());
    };
    let area = state
        .container
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .or(*state.frame.lock().unwrap_or_else(|e| e.into_inner()));
    let Some(rect) = area else {
        return Ok(());
    };
    let (Position::Physical(pos), Size::Physical(size)) = (rect.position, rect.size) else {
        return Ok(());
    };
    let scale = app
        .get_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(2.0);
    let lw = width.min(size.width as f64 / scale).max(1.0);
    let lh = height.min(size.height as f64 / scale).max(1.0);
    let w_px = (lw * scale).round();
    let h_px = (lh * scale).round();
    let x = pos.x + ((size.width as f64 - w_px) / 2.0).round() as i32;
    let y = pos.y + ((size.height as f64 - h_px) / 2.0).round() as i32;
    wv.set_bounds(physical_rect(x, y, w_px as u32, h_px as u32))
        .map_err(|e| e.to_string())
}

/// 前端尺寸切换（预设档位）：mode=fill 或 fixed+宽高（CSS px）
#[tauri::command]
pub fn browser_viewport_set(
    app: AppHandle,
    state: State<'_, BrowserState>,
    mode: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let vp = match (mode.as_deref(), width, height) {
        (Some("fixed"), Some(w), Some(h)) => ViewportMode::Fixed {
            width: w.clamp(200.0, 4000.0),
            height: h.clamp(200.0, 4000.0),
        },
        _ => ViewportMode::Fill,
    };
    set_viewport(&app, &state, vp);
    Ok(())
}

#[tauri::command]
pub fn browser_viewport_get(state: State<'_, BrowserState>) -> Result<Value, String> {
    Ok(viewport_payload(
        *state.viewport.lock().unwrap_or_else(|e| e.into_inner()),
    ))
}

#[tauri::command]
pub fn browser_open_devtools(app: AppHandle) -> Result<(), String> {
    app.get_webview(BROWSER_LABEL)
        .ok_or("browser panel not open")?
        .open_devtools();
    Ok(())
}

/// 读面板页面状态，并把「脚本自己失败」与「页面确实没有地址」区分开。
///
/// `eval_json` 只负责把回调字符串解析成 JSON，不看 `ok` 字段。而 `STATE_JS`
/// 的 catch 分支返回的是 `{ok:false, error}` —— 直接去取 `url` 只会得到空串，
/// 于是「webview 已经失效」和「从没导航过」被压成同一句误导性的 `<empty>`。
/// 那正是上一次 browser_shot 报 `<empty>` 却其实什么也没说出来的原因。
fn page_state(wv: &tauri::webview::Webview<Wry>, guard: &CancelGuard) -> Result<Value, String> {
    let v = eval_json(wv, STATE_JS, guard)?;
    if v["ok"] == false {
        return Err(format!(
            "the panel webview did not answer (its page script failed: {}). The panel is \
             most likely stale or already torn down — reopen the browser panel, or pass an \
             explicit url to browser_shot to photograph a specific page instead.",
            v["error"].as_str().unwrap_or("unknown error")
        ));
    }
    Ok(v)
}

/// 面板 webview 当前的 URL（browser_shot 的相机就是对着它拍的）。
/// 面板没开或读不到就报错——不猜 URL，拍一个用户没看的页面比不拍更糟。
pub fn current_url(guard: &CancelGuard) -> Result<String, String> {
    let app = APP.get().ok_or("browser: app not initialized")?;
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or("browser panel is not open: call browser_navigate first")?;
    let v = page_state(&wv, guard)?;
    let url = v["url"].as_str().unwrap_or("").trim().to_string();
    if url.is_empty() {
        return Err(
            "the panel webview has no loaded document yet (location.href is empty). \
             Navigate it first, or pass an explicit url to browser_shot."
                .into(),
        );
    }
    if url == "about:blank" {
        return Err(
            "the browser panel is still on about:blank — it has not navigated anywhere yet. \
             Pass an explicit url to browser_shot to photograph a specific page instead."
                .into(),
        );
    }
    Ok(url)
}

/* ------------------------------ eval 基元 ------------------------------ */

/// eval JS 并等回调结果，解析为 JSON。阻塞等待（宿主工具线程），轮询取消标志。
/// 回调只给 JSON 字符串（wry 不回传异常）——脚本自带 try/catch 兜底，ok/error 在内容里。
fn eval_json(
    wv: &tauri::webview::Webview<Wry>,
    js: &str,
    guard: &CancelGuard,
) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<String>();
    let tx2 = tx.clone();
    // 回调是 Fn（可能被调多次），用可克隆 sender，收满一条即返回
    wv.eval_with_callback(js.to_string(), move |res| {
        let _ = tx2.send(res);
    })
    .map_err(|e| format!("browser eval failed: {e}"))?;
    drop(tx);
    let deadline = Instant::now() + EVAL_TIMEOUT;
    loop {
        if guard.is_cancelled() {
            return Err("cancelled".into());
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(s) => {
                return serde_json::from_str::<Value>(&s)
                    .map_err(|e| format!("browser eval result is not json: {e}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    return Err("browser eval timeout".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("browser eval channel closed (webview destroyed?)".into());
            }
        }
    }
}

/// eval 一帧动作脚本并要求 ok=true；失败（含 stale ref）转错误
fn eval_action(
    wv: &tauri::webview::Webview<Wry>,
    js: &str,
    guard: &CancelGuard,
    what: &str,
) -> Result<Value, String> {
    let v = eval_json(wv, js, guard)?;
    if v["ok"] == false {
        return Err(format!(
            "{what} failed: {}",
            v["error"].as_str().unwrap_or("unknown error")
        ));
    }
    Ok(v)
}

/// 当前页面状态（url/readyState/title）；async 版供 tauri 命令 await
async fn current_page(wv: &tauri::webview::Webview<Wry>) -> Result<Value, String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(1);
    let tx2 = tx.clone();
    wv.eval_with_callback(STATE_JS.to_string(), move |res| {
        let _ = tx2.try_send(res);
    })
    .map_err(|e| format!("browser eval failed: {e}"))?;
    drop(tx);
    let s = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .map_err(|_| "browser eval timeout".to_string())?
        .ok_or("browser eval channel closed")?;
    serde_json::from_str::<Value>(&s).map_err(|e| format!("browser eval result is not json: {e}"))
}

/// 等页面稳定：readyState=complete 且 url 连续两次轮询不变（覆盖导航与 SPA 变化），
/// 再 settle 一小段让渲染跟上。require_change=true（导航路径）时先等导航真正开始
/// （url 变化或 readyState 离开 complete），否则可能在旧页面上提前判稳。
/// 取消标志在轮询间隙检查。
fn wait_stable(
    wv: &tauri::webview::Webview<Wry>,
    guard: &CancelGuard,
    max: Duration,
    require_change: bool,
    before_url: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + max;
    if require_change {
        let change_deadline = Instant::now() + max.min(Duration::from_secs(10));
        while Instant::now() < change_deadline {
            if guard.is_cancelled() {
                return Err("cancelled".into());
            }
            if let Ok(v) = page_state(wv, guard) {
                let url = v["url"].as_str().unwrap_or("");
                let ready = v["readyState"].as_str().unwrap_or("complete");
                if (!url.is_empty() && url != before_url) || ready != "complete" {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let mut last_url = String::new();
    let mut last_ready = String::new();
    let mut last_err = String::new();
    let mut stable = 0u32;
    // 是否真的见过一个加载完成的页面。整轮都没见过 = 这次导航压根没落到
    // 这个 webview 上（面板还没 attach、webview 被换掉、地址打不开……），
    // 继续往下走只会拿 about:blank 的空快照去骗模型说"这页是 canvas 画的"。
    let mut saw_page = false;
    while Instant::now() < deadline {
        if guard.is_cancelled() {
            return Err("cancelled".into());
        }
        match page_state(wv, guard) {
            Ok(v) => {
                let url = v["url"].as_str().unwrap_or("").to_string();
                let ready = v["readyState"].as_str().unwrap_or("").to_string();
                last_err.clear();
                if ready == "complete" && !url.is_empty() && url != "about:blank" {
                    saw_page = true;
                }
                if ready == "complete" && !url.is_empty() && url == last_url {
                    stable += 1;
                    if stable >= 2 {
                        break;
                    }
                } else {
                    stable = 0;
                    last_url = url.clone();
                    last_ready = ready.clone();
                }
            }
            // 单次轮询失败（如导航瞬间 eval 丢失）不计败，等下一轮
            Err(e) => {
                stable = 0;
                last_err = e;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if !saw_page {
        // 到这里还没见过一个真页面：如实报错，别把失败包装成成功的空快照
        return Err(format!(
            "browser navigation did not load: the panel webview stayed on {} \
             (readyState={:?}, last eval error={:?}). The browser panel may not be open or \
             attached yet — open it, or retry browser_navigate.",
            if last_url.is_empty() { "<empty>" } else { &last_url },
            last_ready,
            last_err
        ));
    }
    std::thread::sleep(Duration::from_millis(400));
    Ok(())
}

/* ------------------------------ agent 动作（host_query 入口） ------------------------------ */

/// 快照并组装模型可读的输出（url/标题/树）。
///
/// ARIA 快照优先（Playwright 注入脚本，见 playwright_script.rs）：能表达
/// canvas/无文本区域，元素带 ref 可精确定位。取不到就装一次 runtime 再试，
/// 仍不行则降级回旧的文本快照——agent 不能因为一次注入失败就失去 DOM 能力。
/// 每一次 browser_* 动作的收尾都走这里，所以降级对调用方完全透明。
fn snapshot_output(
    wv: &tauri::webview::Webview<Wry>,
    guard: &CancelGuard,
) -> Result<Value, String> {
    match aria_snapshot(wv, guard) {
        Ok(v) => return render_snapshot(&v, true),
        Err(first) => {
            // 常见原因是 runtime 没装（页面刚导航过）。装一次再试，仍失败才降级。
            if let Err(err) = eval_json(wv, &crate::playwright_script::install_js(), guard) {
                log::warn!("browser: playwright runtime install failed: {err}");
            }
            match aria_snapshot(wv, guard) {
                Ok(v) => return render_snapshot(&v, true),
                Err(_) => {
                    log::warn!("browser: ARIA snapshot unavailable, falling back to text: {first}");
                }
            }
        }
    }
    let v = eval_json(wv, SNAPSHOT_JS, guard)?;
    if v["ok"] == false {
        return Err(format!(
            "snapshot failed: {}",
            v["error"].as_str().unwrap_or("unknown error")
        ));
    }
    render_snapshot(&v, false)
}

/// 取 ARIA 快照。runtime 未装或注入脚本在新版 Playwright 上失配时返回 Err，
/// 由 [`snapshot_output`] 决定重装还是降级。
fn aria_snapshot(
    wv: &tauri::webview::Webview<Wry>,
    guard: &CancelGuard,
) -> Result<Value, String> {
    let v = eval_json(wv, &crate::playwright_script::aria_snapshot_js(), guard)?;
    if v["ok"] == false {
        return Err(v["error"].as_str().unwrap_or("unknown error").to_string());
    }
    Ok(v)
}

/// 把快照脚本的返回值拼成模型可读输出。`aria` 决定空树的解释——
/// 文本快照的空多半是"还没加载完"，ARIA 的空往往是"这页真的没有可访问元素"
/// （canvas 渲染的图/WebGL 场景），两者的正确下一步不一样，不能共用一句话。
fn render_snapshot(v: &Value, aria: bool) -> Result<Value, String> {
    let url = v["url"].as_str().unwrap_or("").to_string();
    let title = v["title"].as_str().unwrap_or("").to_string();
    let tree = if aria {
        v["snapshot"].as_str().unwrap_or("")
    } else {
        v["tree"].as_str().unwrap_or("")
    };
    let mut out = format!("{url}\n{title}\n");
    if v["truncated"] == true {
        out.push_str("（快照被截断：用 browser_scroll 分段查看或聚焦目标区域）\n");
    }
    if tree.trim().is_empty() {
        // 空树有两种完全不同的成因，下一步也不同。地址还是 about:blank 时
        // 根本不是"这页没元素"，而是页面没加载出来——绝不能报成 canvas。
        if url.is_empty() || url == "about:blank" {
            out.push_str(
                "（面板还停在 about:blank，这一页根本没加载出来。别在这里重试快照：\
                 先确认浏览器面板已打开，或重新 browser_navigate）",
            );
        } else {
            out.push_str(if aria {
                "（本页无可访问元素，多半是 canvas/图片渲染——DOM 里没有可点的东西。\
                 要看画面请用 browser_shot 拍照，不要在这里反复重试快照）"
            } else {
                "（页面无可交互元素或文本，可能仍在加载，稍后重新 browser_snapshot）"
            });
        }
    } else {
        out.push_str(tree);
    }
    Ok(json!({ "output": out, "url": url, "title": title, "truncated": v["truncated"] == true }))
}

/// browser_* 工具的宿主执行入口（tool_exec::handle_tool 分发而来）。
/// 阻塞执行：host_query 走 spawn_blocking 线程，与 bash 同款。
pub fn run_tool(name: &str, p: &Value, guard: &CancelGuard) -> Result<Value, String> {
    let app = APP.get().ok_or("browser: app not initialized")?;

    // 跨步互斥：整个动作（可能含导航等待+快照）期间持锁，其他线程明确收到 busy
    let _gate = ACTION_GATE
        .try_lock()
        .map_err(|_| "browser busy: another browser action is still in flight")?;

    if name == "browser_navigate" {
        let url = parse_web_url(p["url"].as_str().unwrap_or(""))?;
        // 面板 webview 只是"当前这一页"的缓存：句柄失效（主 webview 重载后
        // destroy_for_reload 关过它、或与前端 attach 的那个不是同一个实例）
        // 时重建一次的代价只是一次页面加载，比让 agent 对着 about:blank
        // 空转三十秒划算得多。故第一轮失败后重建重试一次。
        let mut rebuilt = false;
        loop {
            // 重建轮必须先确保旧实例真的摘掉了：create_webview 见到同 label 的
            // webview 还注册着就直接返回 Ok，那样的"重建"是空操作，重试的仍
            // 是那个已经死掉的句柄。close() 的注销不是瞬时的，所以这里轮询等。
            if rebuilt {
                close_and_wait_unregistered(app, Duration::from_secs(3));
            }
            let wv = match app.get_webview(BROWSER_LABEL) {
                Some(wv) => wv,
                None => {
                    // 尚未打开面板：凭空创建（隐藏，等面板 attach 再显示）
                    let state = app.state::<BrowserState>();
                    create_webview(app, &state, url.clone(), None)?;
                    app.get_webview(BROWSER_LABEL)
                        .ok_or("failed to create browser webview")?
                }
            };
            // 同址跳过（重入/幂等），避免 attach 链路上的二次加载
            let before = page_state(&wv, guard)
                .ok()
                .and_then(|v| v["url"].as_str().map(String::from))
                .unwrap_or_default();
            if before != url.as_str() {
                wv.navigate(url.clone())
                    .map_err(|e| format!("browser_navigate: navigate failed: {e}"))?;
            }
            match wait_stable(&wv, guard, NAVIGATE_SETTLE, !rebuilt, &before) {
                // wait_stable 只保证"见过一个加载完成的页面"，不保证那是我们要的
                // 那一页。落地页跳、代理拦截、webview 复用了别的实例时两者会不一致，
                // 而把 A 页的快照当 B 页交给模型，比直接报错糟得多。
                Ok(()) => match page_state(&wv, guard) {
                    Ok(v) => {
                        let landed = v["url"].as_str().unwrap_or("").trim().to_string();
                        if same_page(&landed, url.as_str()) {
                            return snapshot_output(&wv, guard);
                        }
                        let e = format!(
                            "browser_navigate: asked for {url} but the panel landed on \
                             {landed:?}. The page redirected, or the panel webview is not \
                             the one being driven. Reopen the browser panel and retry."
                        );
                        if !rebuilt {
                            log::warn!("[browser] {e}");
                            rebuilt = true;
                            continue;
                        }
                        return Err(e);
                    }
                    Err(e) => return Err(e),
                },
                Err(e) if !rebuilt && e.starts_with("browser navigation did not load") => {
                    log::warn!("[browser] {e}; recreating the panel webview and retrying once");
                    let _ = wv.close();
                    rebuilt = true;
                }
                Err(e) => return Err(e),
            }
        }
    }

    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or("browser panel is not open: call browser_navigate first")?;
    match name {
        "browser_snapshot" => snapshot_output(&wv, guard),
        "browser_resize" => {
            // 视口尺寸切换（响应式调试）：width+height → 固定尺寸；否则回到填满。
            // 面板挂着时 React 帧随事件重排；面板收起时 apply_viewport 直接落位。
            let fill = p["fill"] == true;
            let (w, h) = (p["width"].as_f64(), p["height"].as_f64());
            let vp = if fill || w.is_none() || h.is_none() {
                ViewportMode::Fill
            } else {
                ViewportMode::Fixed {
                    width: w.unwrap().clamp(200.0, 4000.0),
                    height: h.unwrap().clamp(200.0, 4000.0),
                }
            };
            let state = app.state::<BrowserState>();
            set_viewport(app, &state, vp);
            std::thread::sleep(Duration::from_millis(500));
            snapshot_output(&wv, guard)
        }
        "browser_click" => {
            let r = p["ref"].as_str().ok_or("missing param: ref")?;
            let js = CLICK_JS_TEMPLATE
                .replace("__XR_RESOLVE__", RESOLVE_JS)
                .replace("__XR_REF__", &js_escape(r));
            eval_action(&wv, &js, guard, "click")?;
            wait_stable(&wv, guard, ACTION_SETTLE, false, "")?;
            snapshot_output(&wv, guard)
        }
        "browser_type" => {
            let r = p["ref"].as_str().ok_or("missing param: ref")?;
            let text = p["text"].as_str().ok_or("missing param: text")?;
            let submit = p["submit"] == true;
            let js = TYPE_JS_TEMPLATE
                .replace("__XR_RESOLVE__", RESOLVE_JS)
                .replace("__XR_REF__", &js_escape(r))
                .replace(
                    "__XR_VALUE__",
                    &serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
                )
                .replace("__XR_SUBMIT__", if submit { "true" } else { "false" });
            eval_action(&wv, &js, guard, "type")?;
            wait_stable(&wv, guard, ACTION_SETTLE, false, "")?;
            snapshot_output(&wv, guard)
        }
        "browser_scroll" => {
            let dir = p["direction"].as_str().unwrap_or("down").to_lowercase();
            if !["up", "down", "top", "bottom"].contains(&dir.as_str()) {
                return Err(format!("invalid direction: {dir} (up|down|top|bottom)"));
            }
            let amount = p["amount"].as_u64().unwrap_or(600).min(100_000);
            let js = SCROLL_JS_TEMPLATE
                .replace("__XR_DIR__", &js_escape(&dir))
                .replace("__XR_AMOUNT__", &amount.to_string());
            eval_action(&wv, &js, guard, "scroll")?;
            wait_stable(&wv, guard, ACTION_SETTLE, false, "")?;
            snapshot_output(&wv, guard)
        }
        "browser_back" => {
            let before = page_state(&wv, guard)?["url"]
                .as_str()
                .unwrap_or("")
                .to_string();
            eval_action(&wv, BACK_JS, guard, "back")?;
            wait_stable(&wv, guard, ACTION_SETTLE, false, "")?;
            let after = page_state(&wv, guard)?["url"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let mut out = snapshot_output(&wv, guard)?;
            if before == after {
                out["output"] = json!(format!(
                    "历史没有更早的页面（url 未变化：{before}）\n\n{}",
                    out["output"].as_str().unwrap_or("")
                ));
            }
            Ok(out)
        }
        _ => Err(format!("unknown browser tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_web_url_accepts_http_https_file() {
        assert!(parse_web_url("https://example.com").is_ok());
        assert!(parse_web_url("http://example.com/path?x=1").is_ok());
        assert!(parse_web_url("  https://example.com  ").is_ok());
        assert!(parse_web_url("file:///etc/passwd").is_ok());
        assert!(parse_web_url("ftp://example.com").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url("").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    #[test]
    fn js_escape_escapes_quotes_and_backslashes() {
        assert_eq!(js_escape("e12"), "e12");
        assert_eq!(js_escape("a\"b"), "a\\\"b");
        assert_eq!(js_escape("a\\b"), "a\\\\b");
        assert_eq!(js_escape("a\nb"), "a\\nb");
        assert_eq!(js_escape("a\rb"), "a\\rb");
    }

    #[test]
    fn same_page_tolerates_only_trailing_slash() {
        // 容忍的：纯规范化差异
        assert!(same_page("https://a.com/x", "https://a.com/x/"));
        assert!(same_page("  https://a.com/x  ", "https://a.com/x"));
        // 不容忍的：落到别处去了，必须报错而不是把别的页快照当它交出去
        assert!(!same_page("about:blank", "https://a.com/x"));
        assert!(!same_page("", "https://a.com/x"));
        assert!(!same_page("https://a.com/login", "https://a.com/x"));
        assert!(!same_page("https://b.com/x", "https://a.com/x"));
        assert!(!same_page("https://a.com/x?next=1", "https://a.com/x"));
        // 两边都空不算同一个页面
        assert!(!same_page("", ""));
    }
}
