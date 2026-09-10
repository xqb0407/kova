//! 远程访问网关（HTTP + WebSocket 同端口）：
//! 浏览器 ⇄ http://<本机IP>:8787（静态页面，构建产物 out/）
//!        ⇄ ws://<本机IP>:8787/ws（对话通道）⇄ pi-agent sidecar
//! （复用 pi_agent.rs 的 stdin/stdout 通道与 id 配对逻辑）
//!
//! 第一层协议（auth 后透传 sidecar 原始 NDJSON，id 必填）：
//!   客户端（未认证）：{"type":"pair","code":"483920"} | {"type":"auth","token":".."}
//!   客户端（authed）：sidecar 原样格式，如 {"type":"prompt","id":"..",..}、{"type":"abort"}
//!   服务端：{"type":"paired","token":".."} | {"type":"authed"}
//!           | {"type":"error","errorText":".."} | {"type":"closed","reason":".."}
//!           authed 后全部为 sidecar 原样响应/chunk 行（id 已还原为客户端原始 id）
//!
//! 安全（MVP）：
//!   - 配对码 6 位数字只存内存（重启即失效），每连接校验失败 5 次断开，未认证阶段 10s 超时
//!   - token 64hex 持久化于 kv（key: remote.token），仅首次配对下发
//!   - abort 无 id，sidecar 侧为全局中断——远程与本地会互相打断（MVP 接受）

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxumState;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::pi_agent::{ensure_spawned, write_line, PiState};
use crate::store;

const DEFAULT_PORT: u16 = 8787;
const MAX_PAIR_ATTEMPTS: u8 = 5;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_KEY: &str = "remote.token";

// ---------- stdout 行 → 远程连接 的路由表 ----------

struct RouteEntry {
    conn_id: u64,
    client_id: String,
    tx: mpsc::UnboundedSender<String>,
}

fn routes() -> &'static Arc<StdMutex<HashMap<String, RouteEntry>>> {
    static ROUTES: OnceLock<Arc<StdMutex<HashMap<String, RouteEntry>>>> = OnceLock::new();
    ROUTES.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

/// 全部活跃连接（含未认证），出站队列统一从这里投递
fn conns() -> &'static Arc<StdMutex<HashMap<u64, mpsc::UnboundedSender<String>>>> {
    static CONNS: OnceLock<
        Arc<StdMutex<HashMap<u64, mpsc::UnboundedSender<String>>>>,
    > = OnceLock::new();
    CONNS.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// pi_agent stdout 循环调用：命中远程路由则改写回客户端原始 id 并投递，返回 true 表示已消费。
pub(crate) fn try_route(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let Some(sid) = v.get("id").and_then(|x| x.as_str()).map(str::to_owned) else {
        return false;
    };
    let entry = {
        let map = match routes().lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        match map.get(&sid) {
            Some(e) => RouteEntry {
                conn_id: e.conn_id,
                client_id: e.client_id.clone(),
                tx: e.tx.clone(),
            },
            None => return false,
        }
    };
    let mut out = v;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("id".into(), Value::String(entry.client_id.clone()));
    }
    let _ = entry.tx.send(out.to_string());
    if is_terminal(&out) {
        if let Ok(mut map) = routes().lock() {
            map.remove(&sid);
        }
    }
    true
}

/// chunk 流在 finish/error 收尾；其余带 id 的行都是管理类响应（一次性）
fn is_terminal(v: &Value) -> bool {
    match v.get("chunk") {
        Some(c) => matches!(
            c.get("type").and_then(|t| t.as_str()),
            Some("finish") | Some("error")
        ),
        None => true,
    }
}

/// sidecar 退出：清空远程路由并通知所有连接
pub(crate) fn notify_terminated() {
    let error_line = json!({"type": "error", "errorText": "pi-agent terminated"}).to_string();
    if let Ok(mut map) = routes().lock() {
        map.clear();
    }
    if let Ok(map) = conns().lock() {
        for tx in map.values() {
            let _ = tx.send(error_line.clone());
        }
    }
}

// ---------- 网关状态与命令 ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub code: Option<String>,
    pub connections: u32,
    /// 局域网 WS 连接地址（ws://ip:port/ws，主网卡优先）
    pub lan_addresses: Vec<String>,
    /// 浏览器预览地址（http://ip:port，主网卡优先）
    pub http_addresses: Vec<String>,
}

struct RemoteInner {
    shutdown: StdMutex<Option<mpsc::Sender<()>>>,
    task: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    port: StdMutex<Option<u16>>,
    code: StdMutex<Option<String>>,
    conns: AtomicUsize,
}

impl Default for RemoteInner {
    fn default() -> Self {
        Self {
            shutdown: StdMutex::new(None),
            task: StdMutex::new(None),
            port: StdMutex::new(None),
            code: StdMutex::new(None),
            conns: AtomicUsize::new(0),
        }
    }
}

#[derive(Default)]
pub struct RemoteState {
    inner: Arc<RemoteInner>,
}

impl RemoteState {
    fn status(&self) -> RemoteStatus {
        let port = self.inner.port.lock().ok().and_then(|p| *p);
        let (lan_addresses, http_addresses) = match port {
            Some(p) => {
                let ips = lan_ips();
                (
                    ips.iter().map(|ip| format!("ws://{ip}:{p}/ws")).collect(),
                    ips.iter().map(|ip| format!("http://{ip}:{p}")).collect(),
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        RemoteStatus {
            running: self
                .inner
                .shutdown
                .lock()
                .map(|s| s.is_some())
                .unwrap_or(false),
            port,
            code: self.inner.code.lock().ok().and_then(|c| c.clone()),
            connections: self.inner.conns.load(Ordering::Relaxed) as u32,
            lan_addresses,
            http_addresses,
        }
    }
}

/// axum handler 共享上下文
#[derive(Clone)]
struct GatewayCtx {
    app: AppHandle,
    inner: Arc<RemoteInner>,
}

#[tauri::command]
pub async fn pi_remote_start(
    app: AppHandle,
    state: State<'_, RemoteState>,
    port: Option<u16>,
) -> Result<RemoteStatus, String> {
    if state.inner.shutdown.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(state.status());
    }
    let port = port.unwrap_or(DEFAULT_PORT);
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("failed to bind 0.0.0.0:{port}: {e}"))?;
    let code = generate_code();

    let ctx = GatewayCtx {
        app: app.clone(),
        inner: state.inner.clone(),
    };
    let router = Router::new()
        .route("/ws", get(ws_upgrade))
        .fallback(serve_static)
        .with_state(ctx);
    let (tx, mut rx) = mpsc::channel::<()>(1);
    let task = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                rx.recv().await;
            })
            .await;
    });

    *state.inner.shutdown.lock().map_err(|e| e.to_string())? = Some(tx);
    *state.inner.task.lock().map_err(|e| e.to_string())? = Some(task);
    *state.inner.port.lock().map_err(|e| e.to_string())? = Some(port);
    *state.inner.code.lock().map_err(|e| e.to_string())? = Some(code);
    log::info!("[remote] gateway started on 0.0.0.0:{port}");
    Ok(state.status())
}

#[tauri::command]
pub async fn pi_remote_stop(state: State<'_, RemoteState>) -> Result<(), String> {
    stop_sync(&state.inner);
    log::info!("[remote] gateway stopped");
    Ok(())
}

#[tauri::command]
pub async fn pi_remote_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn pi_remote_refresh_code(state: State<'_, RemoteState>) -> Result<String, String> {
    if !state
        .inner
        .shutdown
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("remote gateway is not running".into());
    }
    let code = generate_code();
    *state.inner.code.lock().map_err(|e| e.to_string())? = Some(code.clone());
    Ok(code)
}

/// 应用退出时同步停网关（lib.rs 的 RunEvent::Exit 钩子调用）
pub fn stop_on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<RemoteState>() {
        stop_sync(&state.inner);
    }
}

fn stop_sync(inner: &RemoteInner) {
    let shutdown = inner
        .shutdown
        .lock()
        .ok()
        .and_then(|mut s| s.take());
    let task = inner.task.lock().ok().and_then(|mut t| t.take());
    let _ = inner.port.lock().ok().and_then(|mut p| p.take());
    let _ = inner.code.lock().ok().and_then(|mut c| c.take());
    if let Some(tx) = shutdown {
        let _ = tx.try_send(());
    }
    if let Some(task) = task {
        task.abort();
    }
    // 通知所有连接网关已关闭；随后清空注册表使各连接的出站队列关闭、写任务退出
    let closed = json!({"type": "closed", "reason": "gateway stopped"}).to_string();
    if let Ok(mut map) = conns().lock() {
        for tx in map.values() {
            let _ = tx.send(closed.clone());
        }
        map.clear();
    }
    if let Ok(mut map) = routes().lock() {
        map.clear();
    }
    inner.conns.store(0, Ordering::Relaxed);
}

fn generate_code() -> String {
    let b = Uuid::new_v4().into_bytes();
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    format!("{n:06}")
}

/// token 持久化于 kv；首次生成后复用（重启网关/应用后旧 token 仍有效）
fn load_or_create_token(app: &AppHandle) -> Result<String, String> {
    if let Some(t) = store::kv_get_global(app, TOKEN_KEY)? {
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    store::kv_set_global(app, TOKEN_KEY, &token)?;
    Ok(token)
}

// ---------- 局域网地址 ----------

/// 是否为可对外提供局域网访问的私有 IPv4：
/// RFC1918（10/8、172.16/12、192.168/16）+ CGNAT 100.64/10（Tailscale）。
/// 排除回环、链路本地（169.254）与基准段 198.18.0.0/15（VPN TUN/fake-ip 虚拟网卡常用）。
fn is_lan_ip(ip: Ipv4Addr) -> bool {
    if ip.is_loopback() || ip.is_link_local() {
        return false;
    }
    match ip.octets() {
        [10, ..] => true,
        [172, b, ..] => (16..=31).contains(&b),
        [192, 168, ..] => true,
        [100, b, ..] => (64..=127).contains(&b),
        _ => false,
    }
}

/// 枚举可用的局域网 IPv4（默认路由出口 IP 排最前，仅保留私有段，过滤 VPN TUN 虚拟 IP）
fn lan_ips() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = Vec::new();
    // 默认路由出口 IP（UDP connect 不发包，仅选路）：VPN TUN 接管默认路由时可能是虚拟 IP，需再经 is_lan_ip 过滤
    if let Ok(sock) = std::net::UdpSocket::bind(("0.0.0.0", 0)) {
        if sock.connect(("8.8.8.8", 80)).is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if let IpAddr::V4(ip) = addr.ip() {
                    if is_lan_ip(ip) {
                        ips.push(IpAddr::V4(ip));
                    }
                }
            }
        }
    }
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let IpAddr::V4(ip) = iface.ip() {
                if is_lan_ip(ip) && !ips.contains(&IpAddr::V4(ip)) {
                    ips.push(IpAddr::V4(ip));
                }
            }
        }
    }
    ips
}

// ---------- HTTP 静态页 ----------

/// 构建产物 out/ 目录：生产取打包资源，开发回退源码树
fn frontend_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("out");
        if p.is_dir() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("out");
    if dev.is_dir() {
        return Some(dev);
    }
    None
}

/// Next 静态导出布局：精确文件 → path.html → path/index.html → 无扩展名时回退 index.html
async fn serve_static(AxumState(ctx): AxumState<GatewayCtx>, uri: axum::http::Uri) -> Response {
    let Some(dir) = frontend_dir(&ctx.app) else {
        return hint_page();
    };
    let raw = uri.path().trim_start_matches('/');
    // 目录穿越防护
    if raw.split(['/', '\\']).any(|seg| seg == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if raw.is_empty() { "index.html" } else { raw };

    let mut candidates: Vec<PathBuf> = vec![dir.join(path)];
    if !path.ends_with(".html") {
        candidates.push(dir.join(format!("{path}.html")));
        candidates.push(dir.join(path).join("index.html"));
    }
    for p in candidates {
        if p.is_file() {
            if let Ok(bytes) = tokio::fs::read(&p).await {
                let mime = mime_of(&p.to_string_lossy());
                return (
                    [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache")],
                    bytes,
                )
                    .into_response();
            }
        }
    }
    // 无扩展名的导航请求回退首页（SPA 客户端路由）
    if !path.contains('.') {
        if let Ok(bytes) = tokio::fs::read(dir.join("index.html")).await {
            return (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                bytes,
            )
                .into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

/// out/ 缺失（如开发模式未构建前端）时的提示页
fn hint_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;display:grid;place-items:center;height:100dvh;margin:0'><p style='color:#666'>网页界面尚未构建：请在项目根目录运行 <code>pnpm build</code> 后重启应用。</p></body>",
    )
        .into_response()
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// ---------- WebSocket 连接处理 ----------

async fn ws_upgrade(AxumState(ctx): AxumState<GatewayCtx>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_conn(ctx, socket))
}

async fn handle_conn(ctx: GatewayCtx, socket: WebSocket) {
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let rs = ctx.inner.clone();
    rs.conns.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut map) = conns().lock() {
        map.insert(conn_id, tx.clone());
    }

    // 写任务：出站队列 → socket。队列关闭（清理/停网关）后自然退出
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if sink.send(WsMessage::text(line)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let app = ctx.app.clone();
    let result = read_loop(&app, conn_id, tx, &mut stream, &rs).await;

    // 读侧结束：摘除本连接的路由与注册，写任务随后退出
    if let Ok(mut map) = routes().lock() {
        map.retain(|_, e| e.conn_id != conn_id);
    }
    if let Ok(mut map) = conns().lock() {
        map.remove(&conn_id);
    }
    rs.conns.fetch_sub(1, Ordering::Relaxed);
    let _ = writer.await;
    if let Err(e) = result {
        log::warn!("[remote] connection ended: {e}");
    }
}

/// 入站协议状态机：pair/auth（限次限时）→ authed 后透传 sidecar
async fn read_loop(
    app: &AppHandle,
    conn_id: u64,
    tx: mpsc::UnboundedSender<String>,
    stream: &mut futures_util::stream::SplitStream<
        axum::extract::ws::WebSocket,
    >,
    rs: &Arc<RemoteInner>,
) -> Result<(), String> {
    let send = |v: Value| {
        let _ = tx.send(v.to_string());
    };
    let mut authed = false;
    let mut fail_count: u8 = 0;

    loop {
        // 未认证阶段限时；authed 后不限时
        let next = if authed {
            stream.next().await
        } else {
            match tokio::time::timeout(AUTH_TIMEOUT, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    send(json!({"type": "error", "errorText": "authentication timeout"}));
                    break;
                }
            }
        };
        let msg = match next {
            None => break,
            Some(Err(e)) => return Err(format!("ws read error: {e}")),
            Some(Ok(m)) => m,
        };
        let WsMessage::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else {
            send(json!({"type": "error", "errorText": "invalid json"}));
            continue;
        };
        let mtype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

        if !authed {
            match mtype {
                "pair" => {
                    let expected = rs.code.lock().ok().and_then(|c| c.clone());
                    let supplied = v.get("code").and_then(|x| x.as_str()).unwrap_or("");
                    // MVP：明文比较即可（配对码生命周期仅几分钟，暴力破解受次数限制）
                    if expected.as_deref() == Some(supplied) && !supplied.is_empty() {
                        match load_or_create_token(app) {
                            Ok(token) => {
                                send(json!({"type": "paired", "token": token}));
                                authed = true;
                            }
                            Err(e) => send(json!({"type": "error", "errorText": e})),
                        }
                    } else {
                        fail_count += 1;
                        send(json!({
                            "type": "error",
                            "errorText": "invalid pairing code",
                            "attemptsLeft": MAX_PAIR_ATTEMPTS - fail_count,
                        }));
                    }
                }
                "auth" => {
                    let stored = load_or_create_token(app).unwrap_or_default();
                    let supplied = v.get("token").and_then(|x| x.as_str()).unwrap_or("");
                    if !stored.is_empty() && supplied == stored {
                        send(json!({"type": "authed"}));
                        authed = true;
                    } else {
                        fail_count += 1;
                        send(json!({
                            "type": "error",
                            "errorText": "invalid token",
                            "attemptsLeft": MAX_PAIR_ATTEMPTS - fail_count,
                        }));
                    }
                }
                _ => send(json!({"type": "error", "errorText": "unauthorized"})),
            }
            if fail_count >= MAX_PAIR_ATTEMPTS {
                break;
            }
            continue;
        }

        // authed：透传 sidecar 协议
        if let Err(e) = forward_to_agent(app, conn_id, v, &tx).await {
            send(json!({"type": "error", "errorText": e}));
        }
    }
    Ok(())
}

/// authed 消息转发：重写 id 为 rem-{conn}-{orig} 并登记路由后写入 sidecar stdin
async fn forward_to_agent(
    app: &AppHandle,
    conn_id: u64,
    mut v: Value,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<(), String> {
    // abort 无 id，全局透传，不占路由
    if v.get("type").and_then(|x| x.as_str()) == Some("abort") {
        let pi = app.state::<PiState>();
        ensure_spawned(app, &pi).await?;
        return write_line(&pi, v.to_string()).await;
    }

    let Some(id) = v.get("id").and_then(|x| x.as_str()).map(str::to_owned) else {
        let _ = tx.send(json!({"type": "error", "errorText": "missing id"}).to_string());
        return Ok(());
    };
    let sid = format!("rem-{conn_id}-{id}");
    if let Some(obj) = v.as_object_mut() {
        obj.insert("id".into(), Value::String(sid.clone()));
    }
    if let Ok(mut map) = routes().lock() {
        map.insert(
            sid.clone(),
            RouteEntry {
                conn_id,
                client_id: id,
                tx: tx.clone(),
            },
        );
    }

    let pi = app.state::<PiState>();
    let result = async {
        ensure_spawned(app, &pi).await?;
        write_line(&pi, v.to_string()).await
    }
    .await;
    if result.is_err() {
        if let Ok(mut map) = routes().lock() {
            map.remove(&sid);
        }
    }
    result
}
