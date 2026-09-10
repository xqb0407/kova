//! pi-agent sidecar 桥接：
//! 负责拉起 pi-agent 二进制（bun 编译产物，NDJSON stdio 协议），
//! 把子进程 stdout 逐行以 `pi-chunk` 事件转发给 webview，
//! 并提供 prompt/abort/reset 三个 command 写入 stdin。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

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
        .env("PI_SESSIONS_DIR", sessions_dir.to_string_lossy().to_string());

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pi-agent: {e}"))?;
    log::info!("[pi_agent] sidecar spawned");

    let state_for_rx = Arc::clone(&state.pending);
    let child_slot = Arc::clone(&state.child);
    let app_for_rx = app.clone();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                // shell 插件按行分发 stdout；统一转 UTF-8 字符串处理
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    // sidecar -> 宿主的 RPC（host_query）：查库后经 stdin 回写 host_result。
                    // 计算放阻塞线程池（阶段②工具执行可能耗时数秒），不阻塞 stdout 泵；
                    // 回写拿 child tokio Mutex 与命令写入排队，保证行原子性。
                    let is_host_query = serde_json::from_str::<serde_json::Value>(&line)
                        .ok()
                        .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("host_query"))
                        .is_some();
                    if is_host_query {
                        let app_handle = app_for_rx.clone();
                        let child_slot_for_query = Arc::clone(&child_slot);
                        tauri::async_runtime::spawn(async move {
                            let reply = tauri::async_runtime::spawn_blocking(move || {
                                serde_json::from_str::<serde_json::Value>(&line)
                                    .ok()
                                    .map(|value| {
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
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(req_id) = value.get("id").and_then(|v| v.as_str()) {
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
                    // 远程网关路由（id 形如 rem-{conn}-{orig}），未命中再广播给本地 webview
                    if remote::try_route(&line) {
                        continue;
                    }
                    let _ = emitter.emit("pi-chunk", line);
                }
                CommandEvent::Stderr(line) => {
                    // 落盘 pi-agent.log（sidecar 零改动，stderr 由宿主转发）
                    logging::write_sidecar_line(&String::from_utf8_lossy(&line));
                    log::debug!("[pi_agent] stderr: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    log::error!("[pi_agent] {err}");
                    let _ = emitter.emit(
                        "pi-chunk",
                        format!(
                            "{{\"id\":null,\"chunk\":{{\"type\":\"error\",\"errorText\":{}}}}}",
                            serde_json::to_string(&err).unwrap_or_default()
                        ),
                    );
                }
                CommandEvent::Terminated(status) => {
                    log::warn!("[pi_agent] terminated {status:?}");
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
) -> Result<(), String> {
    ensure_spawned(&app, &state).await?;
    let payload = serde_json::json!({
        "type": "prompt",
        "id": request_id,
        "text": text,
        "threadId": thread_id,
        "sessionId": session_id,
        "cwd": cwd,
    });
    write_line(&state, payload.to_string()).await
}

#[tauri::command]
pub async fn pi_abort(state: State<'_, PiState>) -> Result<(), String> {
    write_line(&state, serde_json::json!({ "type": "abort" }).to_string()).await
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

/// 应用退出时杀掉子进程
pub fn kill_on_exit(state: &PiState) {
    if let Ok(mut guard) = state.child.try_lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}
