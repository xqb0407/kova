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
//! 安全：
//!   - 配对码 6 位数字只存内存（重启即失效），每连接校验失败 5 次断开，未认证阶段 10s 超时
//!   - token 64hex 持久化于 kv（key: remote.token，secret.rs 加密落盘），仅首次配对下发；
//!     pi_remote_revoke 删除 token 并踢掉全部在连设备（需重新扫码配对）
//!   - authed 后仅转发会话/聊天类消息；凭据/MCP/技能/子代理/记忆/个性化/模型属性等
//!     管理类消息命中 REMOTE_DENIED_TYPES 一律拒绝（远程是"对话延伸"，桌面端才能改配置）
//!   - 绑定模式：默认绑 0.0.0.0（局域网跨设备）；"仅本机"（remote.bind.lan=false）
//!     只绑 127.0.0.1。HTTP/WS 均无 TLS——token 与消息在局域网明文，注意网络环境
//!   - abort 无 id，sidecar 侧为全局中断——远程与本地会互相打断

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
use tokio::sync::mpsc::error::TrySendError;
use uuid::Uuid;

use crate::pi_agent::{ensure_spawned, write_line, PiState};
use crate::store;

const DEFAULT_PORT: u16 = 8787;
const MAX_PAIR_ATTEMPTS: u8 = 5;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_KEY: &str = "remote.token";
/// 绑定模式：true = 0.0.0.0（局域网跨设备，默认），false = 仅本机回环
const BIND_LAN_KEY: &str = "remote.bind.lan";

/// authed 后禁止远程转发的消息类型：凭据/提供商管理、MCP 管理（可拉起本地进程）、
/// 技能/子代理写（注入可执行提示词内容）、记忆写、个性化/模型属性/过滤写、
/// 自动化写。命中即断开该消息并回错。会话/聊天类与只读查询不在其列。
/// 第二层防线是 list_custom_providers 只回掩码——即使漏网也读不到明文 key。
const REMOTE_DENIED_TYPES: &[&str] = &[
    // 凭据与 AI 服务管理
    "set_credential",
    "delete_credential",
    "list_credentials",
    "add_custom_provider",
    "delete_custom_provider",
    "toggle_custom_provider",
    "test_provider",
    "fetch_models",
    // MCP：管理面（save/delete/test 可拉起本地进程）+ 授权流程 + 日志读取
    "save_mcp_server",
    "delete_mcp_server",
    "set_mcp_server_enabled",
    "test_mcp_server",
    "authorize_mcp_server",
    "revoke_mcp_server_auth",
    "list_mcp_servers",
    "get_mcp_server_tools",
    "get_mcp_server_log",
    "get_mcp_audit_log",
    // 技能 / 子代理定义写
    "save_skill",
    "delete_skill",
    "set_skill_enabled",
    "set_skills_enabled",
    "save_subagent",
    "delete_subagent",
    "set_subagent_enabled",
    // 记忆与个性化写
    "write_memory_file",
    "set_memory",
    "set_personalization",
    // 模型属性 / 目录覆盖写
    "update_model",
    "set_provider_filter",
    "set_thinking_maps",
    // 自动化写（定时任务在桌面机执行带工具回合，仅桌面端可管理）
    "automation_save",
    "automation_delete",
    "automation_set_enabled",
    "automation_run_now",
    "automation_history_delete",
];

// ---------- stdout 行 → 远程连接 的路由表 ----------

/// 迭代 3b：每连接出站队列上界。有界防止慢客户端把内存吃穿（此前是无界
/// channel，远程端网络一卡 sidecar chunk 就在队列里无限堆积）；写满时
/// try_route 直接踢掉该连接，客户端自动重连续会话。
const OUTBOUND_QUEUE_LIMIT: usize = 2048;

struct RouteEntry {
    conn_id: u64,
    client_id: String,
    tx: mpsc::Sender<String>,
}

/// 连接注册项：数据队列 sender + 强制断开信号。
/// cancel sender 被 drop（kick_conn / 网关停止 / map 清理）即断开该连接——
/// 仅摘除 tx 不够，read_loop 还持有一份 clone，队列不会因此关闭。
struct ConnHandle {
    tx: mpsc::Sender<String>,
    _cancel: tokio::sync::oneshot::Sender<()>,
}

fn routes() -> &'static Arc<StdMutex<HashMap<String, RouteEntry>>> {
    static ROUTES: OnceLock<Arc<StdMutex<HashMap<String, RouteEntry>>>> = OnceLock::new();
    ROUTES.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

/// 全部活跃连接（含未认证），出站队列统一从这里投递
fn conns() -> &'static Arc<StdMutex<HashMap<u64, ConnHandle>>> {
    static CONNS: OnceLock<Arc<StdMutex<HashMap<u64, ConnHandle>>>> = OnceLock::new();
    CONNS.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// 强制断开某连接：摘除注册（drop cancel sender → 写任务退出、socket 关闭）并清其路由。
fn kick_conn(conn_id: u64) {
    if let Ok(mut map) = routes().lock() {
        map.retain(|_, e| e.conn_id != conn_id);
    }
    if let Ok(mut map) = conns().lock() {
        map.remove(&conn_id);
    }
}

/// pi_agent stdout 循环调用：命中远程路由则改写回客户端原始 id 并投递，返回 true 表示已消费。
/// 迭代 3b：接收调用方已 parse 好的行（None = 非法 JSON），且网关未启用/无在飞请求时
/// 由路由表空判断 O(1) 短路——此前每行 stdout 都要在这里再全量 parse 一遍。
pub(crate) fn try_route(parsed: Option<&Value>) -> bool {
    let entry = {
        let map = match routes().lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        if map.is_empty() {
            return false;
        }
        let Some(v) = parsed else { return false };
        let Some(sid) = v.get("id").and_then(|x| x.as_str()) else {
            return false;
        };
        match map.get(sid) {
            Some(e) => (
                sid.to_owned(),
                RouteEntry {
                    conn_id: e.conn_id,
                    client_id: e.client_id.clone(),
                    tx: e.tx.clone(),
                },
            ),
            None => return false,
        }
    };
    let (sid, entry) = entry;
    let Some(v) = parsed else { return false };
    let mut out = v.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("id".into(), Value::String(entry.client_id.clone()));
    }
    match entry.tx.try_send(out.to_string()) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            log::warn!("[remote] outbound queue full, dropping conn {}", entry.conn_id);
            kick_conn(entry.conn_id);
        }
        // 连接已进入清理流程，路由会在读侧结束时统一摘除
        Err(TrySendError::Closed(_)) => {}
    }
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

// ---------- 无 id 自发通知行广播（turn_changed / subagent_activity）----------

/// 已认证连接的出站端注册表。与 read_loop 里的 authed 生命周期一致：
/// 认证通过才入表（未认证连接不得收到会话活动通知），连接清理时移除。
fn authed_txs() -> &'static StdMutex<HashMap<u64, mpsc::Sender<String>>> {
    static TXS: OnceLock<Arc<StdMutex<HashMap<u64, mpsc::Sender<String>>>>> =
        OnceLock::new();
    TXS.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

fn register_authed_conn(conn_id: u64, tx: mpsc::Sender<String>) {
    if let Ok(mut map) = authed_txs().lock() {
        map.insert(conn_id, tx);
    }
}

fn unregister_authed_conn(conn_id: u64) {
    if let Ok(mut map) = authed_txs().lock() {
        map.remove(&conn_id);
    }
}

/// sidecar 的无 id 自发通知行原样广播给全部已认证远程连接（本地 webview
/// 走 pi-chunk-batch，远程此前完全没有这条信号——侧边栏"运行中"指示因此
/// 缺席）。只放行白名单类型，其余无 id 行维持只进本地。队列满按背压踢线
/// （与 try_route 同款），慢客户端不拖垮其它订阅者。
pub(crate) fn broadcast_notification(parsed: Option<&Value>) {
    let Some(v) = parsed else { return };
    if v.get("id").is_some() {
        return;
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("turn_changed") | Some("subagent_activity") | Some("automation_fired")
        | Some("automation_run_done") => {}
        _ => return,
    }
    let Ok(map) = authed_txs().lock() else { return };
    if map.is_empty() {
        return;
    }
    let line = v.to_string();
    for (conn_id, tx) in map.iter() {
        match tx.try_send(line.clone()) {
            Ok(()) | Err(TrySendError::Closed(_)) => {}
            Err(TrySendError::Full(_)) => {
                log::warn!("[remote] broadcast queue full, dropping conn {conn_id}");
                kick_conn(*conn_id);
            }
        }
    }
}

/// sidecar 退出：清空远程路由并通知所有连接
pub(crate) fn notify_terminated() {
    let error_line = json!({"type": "error", "errorText": "pi-agent terminated"}).to_string();
    if let Ok(mut map) = routes().lock() {
        map.clear();
    }
    if let Ok(map) = conns().lock() {
        for h in map.values() {
            let _ = h.tx.try_send(error_line.clone());
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
    /// 绑定模式：true = 局域网可达（0.0.0.0），false = 仅本机（127.0.0.1）
    pub lan: bool,
    /// 局域网 WS 连接地址（ws://ip:port/ws，主网卡优先；仅本机模式只回回环地址）
    pub lan_addresses: Vec<String>,
    /// 浏览器预览地址（http://ip:port，主网卡优先；仅本机模式只回回环地址）
    pub http_addresses: Vec<String>,
}

struct RemoteInner {
    shutdown: StdMutex<Option<mpsc::Sender<()>>>,
    task: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    port: StdMutex<Option<u16>>,
    code: StdMutex<Option<String>>,
    /// 当前网关生效的绑定模式（与 kv remote.bind.lan 同步）
    lan: StdMutex<bool>,
    conns: AtomicUsize,
}

impl Default for RemoteInner {
    fn default() -> Self {
        Self {
            shutdown: StdMutex::new(None),
            task: StdMutex::new(None),
            port: StdMutex::new(None),
            code: StdMutex::new(None),
            lan: StdMutex::new(true),
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
        let lan = self.inner.lan.lock().map(|l| *l).unwrap_or(true);
        let (lan_addresses, http_addresses) = match port {
            Some(p) => {
                // 仅本机模式不枚举网卡地址（也没有可分享的局域网入口）
                let ips: Vec<IpAddr> = if lan {
                    lan_ips()
                } else {
                    vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]
                };
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
            lan,
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
    lan: Option<bool>,
) -> Result<RemoteStatus, String> {
    // 绑定模式：显式传入则持久化（remote.bind.lan），否则沿用上次的选择（默认局域网）。
    // 网关在跑且模式有变 → 先停再起，让切换即时生效。
    if let Some(v) = lan {
        store::kv_set_global(&app, BIND_LAN_KEY, if v { "true" } else { "false" })?;
    }
    let lan = match lan {
        Some(v) => v,
        None => match store::kv_get_global(&app, BIND_LAN_KEY)? {
            Some(s) => s != "false",
            None => true,
        },
    };
    let running = state.inner.shutdown.lock().map_err(|e| e.to_string())?.is_some();
    if running {
        let same_mode = state.inner.lan.lock().map(|l| *l == lan).unwrap_or(true);
        if same_mode {
            return Ok(state.status());
        }
        stop_sync(&state.inner);
    }
    let port = port.unwrap_or(DEFAULT_PORT);
    let bind_ip = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = TcpListener::bind((bind_ip, port))
        .await
        .map_err(|e| format!("failed to bind {bind_ip}:{port}: {e}"))?;
    *state.inner.lan.lock().map_err(|e| e.to_string())? = lan;
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
    log::info!("[remote] gateway started on {bind_ip}:{port} (lan={lan})");
    Ok(state.status())
}

#[tauri::command]
pub async fn pi_remote_stop(state: State<'_, RemoteState>) -> Result<(), String> {
    stop_sync(&state.inner);
    log::info!("[remote] gateway stopped");
    Ok(())
}

#[tauri::command]
pub async fn pi_remote_status(
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Result<RemoteStatus, String> {
    let mut st = state.status();
    if !st.running {
        // 未运行时展示持久化的绑定模式（下次 start 生效的就是它）
        st.lan = match store::kv_get_global(&app, BIND_LAN_KEY)? {
            Some(s) => s != "false",
            None => true,
        };
    }
    Ok(st)
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

/// 撤销全部已配对设备：删除持久化 token 并踢掉当前所有连接。
/// 之后旧 token 全部失效（含内存中已认证的连接），新设备需重新扫码配对。
#[tauri::command]
pub async fn pi_remote_revoke(app: AppHandle, state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    store::kv_delete_global(&app, TOKEN_KEY)?;
    let ids: Vec<u64> = conns()
        .lock()
        .map(|m| m.keys().copied().collect())
        .map_err(|e| e.to_string())?;
    let n = ids.len();
    for id in ids {
        kick_conn(id);
    }
    log::info!("[remote] token revoked; {n} connection(s) kicked");
    Ok(state.status())
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
        for h in map.values() {
            let _ = h.tx.try_send(closed.clone());
        }
        // clear 同时 drop 各连接的 cancel sender，写任务退出、socket 关闭
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

/// token 持久化于 kv（secret.rs 加密落盘）；首次生成后复用（重启网关/应用
/// 后旧 token 仍有效）。存量旧明文在下次写入时自动升级为密文；密文解密失败
/// （keychain 重置/库搬机）则换新 token——所有已配对设备需重新扫码配对。
fn load_or_create_token(app: &AppHandle) -> Result<String, String> {
    if let Some(t) = store::kv_get_global(app, TOKEN_KEY)? {
        if !t.is_empty() {
            match crate::secret::decrypt(&t) {
                Ok(plain) => return Ok(plain),
                Err(e) => log::warn!("[remote] stored token undecryptable, rotating: {e}"),
            }
        }
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    store::kv_set_global(app, TOKEN_KEY, &crate::secret::encrypt(&token))?;
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

/// 远程网页的 CSP：与 tauri.conf.json 同策略（脚本只准同源+Next 导出内联；
/// 禁 object/base 劫持；connect 放开 ws/wss 供连接页指向任意网关）
const PAGE_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; \
    connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' data: blob:; \
    media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

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
                    [
                        (header::CONTENT_TYPE, mime),
                        (header::CACHE_CONTROL, "no-cache"),
                        (header::CONTENT_SECURITY_POLICY, PAGE_CSP),
                    ],
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
                    (header::CONTENT_SECURITY_POLICY, PAGE_CSP),
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
    let (tx, mut rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_LIMIT);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let rs = ctx.inner.clone();
    rs.conns.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut map) = conns().lock() {
        map.insert(conn_id, ConnHandle { tx: tx.clone(), _cancel: cancel_tx });
    }

    // 写任务：出站队列 → socket。队列关闭（清理/停网关）或 cancel sender
    // 被 drop（kick_conn 背压踢线）后退出并关闭 socket
    let writer = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    let Some(line) = maybe else { break };
                    if sink.send(WsMessage::text(line)).await.is_err() {
                        break;
                    }
                }
                _ = &mut cancel_rx => break,
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
    unregister_authed_conn(conn_id);
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
    tx: mpsc::Sender<String>,
    stream: &mut futures_util::stream::SplitStream<
        axum::extract::ws::WebSocket,
    >,
    rs: &Arc<RemoteInner>,
) -> Result<(), String> {
    let send = |v: Value| {
        let _ = tx.try_send(v.to_string());
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
                                register_authed_conn(conn_id, tx.clone());
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
                        register_authed_conn(conn_id, tx.clone());
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
    tx: &mpsc::Sender<String>,
) -> Result<(), String> {
    // 管理类消息在网关即拒（REMOTE_DENIED_TYPES 黑名单，见常量注释）：
    // 远程只是对话延伸，凭据/MCP/技能/自动化等配置变更仅限桌面端。
    let mtype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if REMOTE_DENIED_TYPES.contains(&mtype) {
        return Err("该操作仅限桌面端".into());
    }
    // abort 无 id，全局透传，不占路由
    if v.get("type").and_then(|x| x.as_str()) == Some("abort") {
        let pi = app.state::<PiState>();
        ensure_spawned(app, &pi).await?;
        return write_line(&pi, v.to_string()).await;
    }

    let Some(id) = v.get("id").and_then(|x| x.as_str()).map(str::to_owned) else {
        let _ = tx.try_send(json!({"type": "error", "errorText": "missing id"}).to_string());
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
