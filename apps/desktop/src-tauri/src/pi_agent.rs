//! pi-agent sidecar 桥接：
//! 负责拉起 pi-agent 二进制（bun 编译产物，NDJSON stdio 协议），
//! 把子进程 stdout 合帧后以 `pi-chunk-batch` 事件转发给 webview（迭代 3，
//! 见 CHUNK_BATCH_WINDOW 注释），并提供 prompt/abort/reset 三个 command 写入 stdin。
//!
//! 刷新恢复：stdout 循环同时为每个进行中的 prompt requestId 维护一份带 seq 的
//! chunk 行缓冲（见 runs()），webview 刷新后前端经 `pi_attach` 取快照重放，
//! 配合监听先行的 seq 去重实现"断线续流"。sidecar 协议零改动。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use crate::logging;
use crate::remote;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};

/// sidecar 子进程句柄（None = 尚未启动）
#[derive(Default)]
pub struct PiState {
    child: Arc<Mutex<Option<CommandChild>>>,
    /// 请求-响应配对：reqId -> 回调（pi_request 管理类请求用）
    pending: Arc<StdMutex<std::collections::HashMap<String, oneshot::Sender<String>>>>,
}

static NEXT_REQ_ID: AtomicU64 = AtomicU64::new(1);

pub fn new_request_id() -> String {
    format!("pi-{}", NEXT_REQ_ID.fetch_add(1, Ordering::Relaxed))
}

// ---------- Rust→webview 转发合帧（迭代 3 / P3） ----------

/// 流式输出时 sidecar 按 token 逐行吐 chunk，逐行 emit 会让 webview 事件分发
/// 频率与 token 速率同阶（每行一次 JS 回调 + JSON 解析）。缓冲后每 ~20ms
/// 或攒满 CHUNK_BATCH_MAX 行，一次性以 `pi-chunk-batch`（Vec<String>）发出。
/// finish/error 行入队后立即冲刷（收尾零延迟）；被 host RPC / 请求配对 /
/// 远程路由消费的行不进入批次。
const CHUNK_BATCH_WINDOW: Duration = Duration::from_millis(20);
const CHUNK_BATCH_MAX: usize = 64;

/// Rust→webview 转发的一行：`l` = sidecar 原始 NDJSON 行；`i` = 该行的 run 内
/// 序号（仅带字符串 id 且含 chunk 对象的行有序号，其余为 null）。前端用 i 对
/// pi_attach 快照与实时广播做幂等去重（两者在"挂监听→取快照"窗口内重叠）。
#[derive(Clone, serde::Serialize)]
pub struct ChunkLine {
    pub i: Option<u64>,
    pub l: String,
}

fn flush_chunks(emitter: &AppHandle, batch: &mut Vec<ChunkLine>) {
    if batch.is_empty() {
        return;
    }
    let lines = std::mem::take(batch);
    let _ = emitter.emit("pi-chunk-batch", &lines);
}

// ---------- 进行中 run 的重放缓冲（刷新恢复） ----------

struct RunEntry {
    /// 已分配的最后一个行序号（从 1 递增，稠密无洞）
    seq: u64,
    lines: Vec<(u64, String)>,
    bytes: usize,
    /// finish/error 后转 false；tombstone（active=false）保留供迟到的
    /// pi_attach 完整重放（含收尾行），下一次 pi_prompt 时统一清扫
    active: bool,
    /// 超出缓冲上限：重放有洞，前端见此标志即放弃续流回退历史加载
    truncated: bool,
}

fn runs() -> &'static StdMutex<HashMap<String, RunEntry>> {
    static RUNS: OnceLock<StdMutex<HashMap<String, RunEntry>>> = OnceLock::new();
    RUNS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// 单 run 缓冲上限：约一轮超长输出（token 级 chunk）的体量；到顶即 truncated
/// 放弃重放（内存不随后台长跑无限增长）。
/// 字节预算按图片投影定标（docs/image-part-design.md）：工具结果 data-image 行的
/// base64 单图 ≤2.7MiB（sidecar 内联上限 2MiB 原始字节），4MiB 预算会被一张图吃掉
/// 大半、轻易触发整 run 降级，故留到 16MiB ≈ 数张图 + 一轮长文本的余量。
const RUN_BUFFER_MAX_LINES: usize = 30_000;
const RUN_BUFFER_MAX_BYTES: usize = 16 * 1024 * 1024;

/// stdout 行进入重放缓冲并领取 seq。只有"字符串 id + chunk 对象"的行参与；
/// 远程行（rem-*）同样缓冲，为远程网关 resume（二期）留位。
fn buffer_run_line(parsed: Option<&serde_json::Value>, line: &str) -> Option<u64> {
    let v = parsed?;
    let rid = v.get("id").and_then(|x| x.as_str())?;
    let chunk = v.get("chunk")?;
    let is_terminal = matches!(
        chunk.get("type").and_then(|t| t.as_str()),
        Some("finish") | Some("error")
    );
    let mut map = runs().lock().ok()?;
    let e = map.entry(rid.to_owned()).or_insert(RunEntry {
        seq: 0,
        lines: Vec::new(),
        bytes: 0,
        active: true,
        truncated: false,
    });
    e.seq += 1;
    if !e.truncated {
        if e.lines.len() + 1 > RUN_BUFFER_MAX_LINES || e.bytes + line.len() > RUN_BUFFER_MAX_BYTES {
            e.truncated = true;
            e.lines.clear();
            e.bytes = 0;
        } else {
            e.bytes += line.len();
            e.lines.push((e.seq, line.to_owned()));
        }
    }
    if is_terminal {
        e.active = false;
    }
    Some(e.seq)
}

/// 不允许在合帧窗口里滞留的行：chunk 的 finish/error（流收尾）与非 chunk
/// 行（管理/通知类，低频）。解析失败的裸行也算，保持原样尽快送达。
fn is_flush_line(v: Option<&serde_json::Value>) -> bool {
    match v.and_then(|v| v.get("chunk")) {
        Some(c) => matches!(
            c.get("type").and_then(|t| t.as_str()),
            Some("finish") | Some("error")
        ),
        None => true,
    }
}

/// 解析应用数据目录（state.db 与会话 JSONL 所在位置）
fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create data dir: {e}"))?;
    Ok(dir)
}

/// 确保子进程已启动；返回 stdout 事件监听是否已由本次调用挂上
pub(crate) async fn ensure_spawned(app: &AppHandle, state: &PiState) -> Result<(), String> {
    let mut guard = state.child.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let data_dir = resolve_app_data_dir(app)?;
    let sessions_dir = data_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|e| format!("failed to create sessions dir: {e}"))?;
    let cmd = app
        .shell()
        .sidecar("pi-agent")
        .map_err(|e| format!("failed to resolve pi-agent sidecar: {e}"))?
        .env("PI_DB_PATH", data_dir.join("state.db").to_string_lossy().to_string())
        .env("PI_SESSIONS_DIR", sessions_dir.to_string_lossy().to_string())
        // 无目录任务会话的执行目录根（sidecar taskWorkspaceBase）：不落家目录；
        // 根下按会话分子目录（<task-workspace>/<sessionId>），全局任务产物互不混堆
        .env(
            "PI_TASK_CWD",
            data_dir.join("task-workspace").to_string_lossy().to_string(),
        );

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pi-agent: {e}"))?;
    log::info!("[pi_agent] sidecar spawned");

    let state_for_rx = Arc::clone(&state.pending);
    let child_slot = Arc::clone(&state.child);
    let app_for_rx = app.clone();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut batch: Vec<ChunkLine> = Vec::new();
        let mut window_opened_at: Option<Instant> = None;
        loop {
            // 缓冲区有货时，recv 与合帧窗口剩余时间赛跑；窗口到期立即冲刷。
            // 空批次时不挂定时器——静默期不产生任何事件。
            let event = match window_opened_at {
                None => rx.recv().await,
                Some(opened) => {
                    let remaining = CHUNK_BATCH_WINDOW.saturating_sub(opened.elapsed());
                    match tokio::time::timeout(remaining, rx.recv()).await {
                        Ok(event) => event,
                        Err(_) => {
                            flush_chunks(&emitter, &mut batch);
                            window_opened_at = None;
                            continue;
                        }
                    }
                }
            };
            let Some(event) = event else {
                flush_chunks(&emitter, &mut batch);
                break;
            };
            match event {
                // shell 插件按行分发 stdout；统一转 UTF-8 字符串处理
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    // 每行只 parse 一次，结果沿链路传递（此前最多三次全量 parse）
                    let parsed = serde_json::from_str::<serde_json::Value>(&line).ok();
                    let msg_type = parsed
                        .as_ref()
                        .and_then(|v| v.get("type").and_then(|t| t.as_str()));
                    // sidecar -> 宿主的取消通知（host_cancel）：立即杀掉对应工具进程树。
                    // 必须在此显式拦截，否则会走 id 配对 / try_route 被广播给 webview。
                    if msg_type == Some("host_cancel") {
                        if let Some(id) = parsed
                            .as_ref()
                            .and_then(|v| v.get("id").and_then(|i| i.as_str()))
                        {
                            crate::tool_exec::cancel_tool(id);
                        }
                        continue;
                    }
                    // sidecar -> 宿主的 RPC（host_query）：查库后经 stdin 回写 host_result。
                    // 计算放阻塞线程池（阶段②工具执行可能耗时数秒），不阻塞 stdout 泵；
                    // 回写拿 child tokio Mutex 与命令写入排队，保证行原子性。
                    if msg_type == Some("host_query") {
                        let app_handle = app_for_rx.clone();
                        let child_slot_for_query = Arc::clone(&child_slot);
                        tauri::async_runtime::spawn(async move {
                            let reply = tauri::async_runtime::spawn_blocking(move || {
                                parsed.map(|value| {
                                    let db = app_handle.state::<crate::store::DbState>();
                                    crate::data::dispatch_host_query(&db.0, &value).to_string()
                                })
                            })
                            .await
                            .ok()
                            .flatten();
                            let Some(reply) = reply else { return };
                            let mut guard = child_slot_for_query.lock().await;
                            if let Some(child) = guard.as_mut() {
                                let _ = child.write(reply.as_bytes());
                                let _ = child.write(b"\n");
                            }
                        });
                        continue;
                    }
                    // 先尝试请求-响应配对（管理类请求），未命中则作为流式 chunk 转发
                    if let Some(v) = parsed.as_ref() {
                        if let Some(req_id) = v.get("id").and_then(|v| v.as_str()) {
                            let sender = state_for_rx
                                .lock()
                                .ok()
                                .and_then(|mut map| map.remove(req_id));
                            if let Some(tx) = sender {
                                let _ = tx.send(line);
                                continue;
                            }
                        }
                    }
                    // 进入重放缓冲并领取 run 内 seq（刷新恢复用，见 runs()）；
                    // 在路由分流之前做，本地/远程行统一缓冲
                    let seq = buffer_run_line(parsed.as_ref(), &line);
                    // 无 id 自发通知行（turn_changed / subagent_activity）广播给远程连接，
                    // 本地照常走下方帧合批；远程路由（rem-*）行带 id，此处为 no-op
                    remote::broadcast_notification(parsed.as_ref());
                    // 远程网关路由（id 形如 rem-{conn}-{orig}），未命中则入帧合批广播给本地 webview
                    if remote::try_route(parsed.as_ref()) {
                        continue;
                    }
                    if batch.is_empty() {
                        window_opened_at = Some(Instant::now());
                    }
                    let flush_now =
                        is_flush_line(parsed.as_ref()) || batch.len() + 1 >= CHUNK_BATCH_MAX;
                    batch.push(ChunkLine { i: seq, l: line });
                    if flush_now {
                        flush_chunks(&emitter, &mut batch);
                        window_opened_at = None;
                    }
                }
                CommandEvent::Stderr(line) => {
                    // 落盘 pi-agent.log（sidecar 零改动，stderr 由宿主转发）；
                    // 先脱敏：崩溃栈/依赖告警可能把带 key 的请求头写进日志
                    let text = redact_secrets(&String::from_utf8_lossy(&line));
                    logging::write_sidecar_line(&text);
                    log::debug!("[pi_agent] stderr: {text}");
                }
                CommandEvent::Error(err) => {
                    log::error!("[pi_agent] {err}");
                    // 先冲刷已缓冲 chunk 再发错误行，维持 sidecar 输出顺序
                    flush_chunks(&emitter, &mut batch);
                    window_opened_at = None;
                    let _ = emitter.emit(
                        "pi-chunk-batch",
                        vec![ChunkLine {
                            i: None,
                            l: format!(
                                "{{\"id\":null,\"chunk\":{{\"type\":\"error\",\"errorText\":{}}}}}",
                                serde_json::to_string(&err).unwrap_or_default()
                            ),
                        }],
                    );
                }
                CommandEvent::Terminated(status) => {
                    log::warn!("[pi_agent] terminated {status:?}");
                    // 收尾前先把最后一帧 chunk 送达，pi-exit 之后不应再有 chunk
                    flush_chunks(&emitter, &mut batch);
                    // sidecar 已退出：清掉所有在飞工具（杀残留进程树、注销登记），
                    // 避免孤儿 bash 进程继续跑
                    crate::tool_exec::cancel_all_tools();
                    // 重放缓冲随进程作废（重启后 requestId 语义不复存在）
                    if let Ok(mut map) = runs().lock() {
                        map.clear();
                    }
                    // 清空所有挂起的请求
                    if let Ok(mut map) = state_for_rx.lock() {
                        for (_, tx) in map.drain() {
                            let _ = tx.send("{\"type\":\"error\",\"errorText\":\"pi-agent terminated\"}".into());
                        }
                    }
                    // 同步通知远程网关连接
                    remote::notify_terminated();
                    let _ = emitter.emit("pi-exit", status.code.unwrap_or(-1).to_string());
                    // 清掉死掉的子进程句柄，下次 ensure_spawned 会自动重新拉起
                    *child_slot.lock().await = None;
                    break;
                }
                _ => {}
            }
        }
    });

    *guard = Some(child);
    Ok(())
}

/// 写入一行 NDJSON 到 sidecar stdin（child Mutex 保证行原子性，多来源并发写安全）
pub(crate) async fn write_line(state: &PiState, line: String) -> Result<(), String> {
    let mut guard = state.child.lock().await;
    let write_result = match guard.as_mut() {
        Some(child) => child
            .write(line.as_bytes())
            .and_then(|_| child.write(b"\n")),
        None => return Err("pi-agent is not running".into()),
    };
    if let Err(e) = write_result {
        // 管道破裂说明子进程已死：清掉句柄，下次 ensure_spawned 自动重启
        *guard = None;
        return Err(format!("failed to write to pi-agent stdin: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn pi_prompt(
    app: AppHandle,
    state: State<'_, PiState>,
    request_id: String,
    text: String,
    thread_id: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    // attachments = 用户图片附件（多模态输入）：原样透传给 sidecar（闸门在彼端，
    // 见 pi-agent prompt-attachments.ts）；无附件为 null
    attachments: Option<serde_json::Value>,
    // steer = 并入当前轮：sidecar 忙线程把消息注入活跃轮（不排队），本请求退化流收尾
    steer: Option<bool>,
) -> Result<(), String> {
    ensure_spawned(&app, &state).await?;
    // 新 run 登记重放缓冲；顺带清扫上一批已结束（tombstone）的条目
    if let Ok(mut map) = runs().lock() {
        map.retain(|_, e| e.active);
        map.insert(
            request_id.clone(),
            RunEntry {
                seq: 0,
                lines: Vec::new(),
                bytes: 0,
                active: true,
                truncated: false,
            },
        );
    }
    let payload = serde_json::json!({
        "type": "prompt",
        "id": request_id,
        "text": text,
        "threadId": thread_id,
        "sessionId": session_id,
        "cwd": cwd,
        "attachments": attachments,
        "steer": steer,
    });
    write_line(&state, payload.to_string()).await
}

/// 刷新恢复：取某 requestId 的重放快照（不消费缓冲，直播照常续传）。
/// 前端时序：先挂 pi-chunk-batch 监听（行带 i 序号暂存），再调本命令取快照，
/// 两路按 seq 幂等合并；无条目（从未跑过/已被终止清空）= active:false 空快照，
/// 调用方据此回退历史加载。
#[derive(serde::Serialize)]
pub(crate) struct AttachReply {
    active: bool,
    truncated: bool,
    lines: Vec<ChunkLine>,
}

#[tauri::command]
pub async fn pi_attach(request_id: String) -> Result<AttachReply, String> {
    let map = runs().lock().map_err(|e| format!("runs lock poisoned: {e}"))?;
    Ok(match map.get(&request_id) {
        Some(e) => AttachReply {
            active: e.active,
            truncated: e.truncated,
            lines: e
                .lines
                .iter()
                .map(|(i, l)| ChunkLine {
                    i: Some(*i),
                    l: l.clone(),
                })
                .collect(),
        },
        None => AttachReply {
            active: false,
            truncated: false,
            lines: Vec::new(),
        },
    })
}

#[tauri::command]
pub async fn pi_abort(
    state: State<'_, PiState>,
    thread_id: Option<String>,
) -> Result<(), String> {
    // thread_id 缺省 = 全局兜底中断；提供时只停该线程（队列按线程隔离）
    write_line(
        &state,
        serde_json::json!({ "type": "abort", "threadId": thread_id }).to_string(),
    )
    .await
}

#[tauri::command]
pub async fn pi_reset(app: AppHandle, state: State<'_, PiState>) -> Result<(), String> {
    ensure_spawned(&app, &state).await?;
    let payload = serde_json::json!({ "type": "new_session", "id": new_request_id() });
    write_line(&state, payload.to_string()).await
}

/// 管理类请求-响应（list_sessions / new_session / get_history / delete_session / rename_session）。
/// Rust 侧生成 req id 并挂起 oneshot，子进程 stdout 中匹配 id 的行直接作为响应返回。
#[tauri::command]
pub async fn pi_request(
    app: AppHandle,
    state: State<'_, PiState>,
    payload: serde_json::Value,
) -> Result<String, String> {
    ensure_spawned(&app, &state).await?;

    let req_id = format!("mgr-{}", new_request_id());
    let (tx, rx) = oneshot::channel::<String>();
    state
        .pending
        .lock()
        .map_err(|e| format!("pending map poisoned: {e}"))?
        .insert(req_id.clone(), tx);

    let mut msg = payload;
    if let Some(obj) = msg.as_object_mut() {
        obj.insert("id".into(), serde_json::Value::String(req_id.clone()));
    }

    if let Err(err) = write_line(&state, msg.to_string()).await {
        // 写失败要撤掉挂起的 sender，避免泄漏
        if let Ok(mut map) = state.pending.lock() {
            map.remove(&req_id);
        }
        return Err(err);
    }

    match rx.await {
        Ok(line) => Ok(line),
        Err(_) => {
            // sender 已被 stdout 循环或 terminate 移除
            Err("pi-agent request dropped".into())
        }
    }
}

/// sidecar 退出宽限：发 shutdown 后最多等多久（sidecar 内部结算封顶 5s，
/// 留 1s 给 stdout 冲刷与进程收尾）
const SHUTDOWN_GRACE: Duration = Duration::from_secs(6);

/// 应用退出时优雅终止子进程：先向 stdin 写 `shutdown`（sidecar 会把在飞 run
/// 的 partial 结算落盘、断 MCP、冲刷 stdout 后自行退出），轮询子进程句柄
/// 最多宽限 6s——stdout 读循环收到 Terminated 时会把句柄清成 None；
/// 超时或写入失败照旧 SIGKILL 兜底。
/// 注意：tauri dev 热重启走进程组信号、不经过本函数，该场景的丢消息兜底
/// 靠 sidecar 在 message_end 的逐条落盘（stream.ts L0-1）。
pub fn kill_on_exit(state: &PiState) {
    let sent = tauri::async_runtime::block_on(write_line(state, "{\"type\":\"shutdown\"}".into()));
    if sent.is_ok() {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            let exited = matches!(state.child.try_lock(), Ok(guard) if guard.is_none());
            if exited || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if let Ok(mut guard) = state.child.try_lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

/// sidecar stderr 脱敏：把常见密钥形态（`sk-…` 长 token、`Bearer …`）打码后
/// 再落盘/写日志——sidecar 崩溃栈或依赖库告警可能把请求头带进 stderr。
/// 与 sidecar 侧 agent-errors.ts 的脱敏互为双保险。
fn redact_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rest = &input[i..];
        if rest.starts_with("sk-") {
            let mut j = i + 3;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_') {
                j += 1;
            }
            if j - i > 10 {
                out.push_str("sk-***");
                i = j;
                continue;
            }
        }
        if rest.starts_with("Bearer ") {
            let mut j = i + 7;
            while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b'"' && bytes[j] != b',' {
                j += 1;
            }
            out.push_str("Bearer ***");
            i = j;
            continue;
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact_secrets;

    #[test]
    fn masks_key_shaped_tokens() {
        assert_eq!(
            redact_secrets("auth failed sk-abcdefghij1234 x"),
            "auth failed sk-*** x"
        );
        assert_eq!(
            redact_secrets("{\"Authorization\":\"Bearer tok-1234567890\"}"),
            "{\"Authorization\":\"Bearer ***\"}"
        );
        // 短 sk- 前缀（占位符/普通词）不误伤；非敏感文本原样
        assert_eq!(redact_secrets("sk-... placeholder; sk short"), "sk-... placeholder; sk short");
    }
}
