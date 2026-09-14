//! Webhook 推送记录：SQLite 表 webhook_delivery 的写入/查询/清理。
//! 前端 dispatcher 每次派发后落一条；设置页只查最近 20 条，
//! 「清理」删除最新 20 条以外的历史记录。

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::store::DbState;

/// 建表（store::init 里调用，与业务表同库 state.db）
pub fn init_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS webhook_delivery (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint    TEXT NOT NULL,
            event       TEXT NOT NULL,
            ok          INTEGER NOT NULL,
            detail      TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("failed to init webhook_delivery: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookDeliveryRow {
    pub id: i64,
    pub endpoint: String,
    pub event: String,
    pub ok: bool,
    pub detail: String,
    pub duration_ms: i64,
    /// epoch 毫秒
    pub created_at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn webhook_delivery_add(
    state: State<'_, DbState>,
    endpoint: String,
    event: String,
    ok: bool,
    detail: String,
    duration_ms: i64,
) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO webhook_delivery(endpoint, event, ok, detail, duration_ms, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![endpoint, event, ok as i64, detail, duration_ms, now_ms()],
    )
    .map_err(|e| format!("failed to insert webhook_delivery: {e}"))?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn webhook_delivery_list(
    state: State<'_, DbState>,
    limit: Option<i64>,
) -> Result<Vec<WebhookDeliveryRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let mut stmt = conn
        .prepare(
            "SELECT id, endpoint, event, ok, detail, duration_ms, created_at
             FROM webhook_delivery ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(WebhookDeliveryRow {
                id: row.get(0)?,
                endpoint: row.get(1)?,
                event: row.get(2)?,
                ok: row.get::<_, i64>(3)? != 0,
                detail: row.get(4)?,
                duration_ms: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 删除某端点的全部推送记录（端点被删时级联清理），返回删除数
#[tauri::command]
pub fn webhook_delivery_delete(
    state: State<'_, DbState>,
    endpoint: String,
) -> Result<u64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute(
            "DELETE FROM webhook_delivery WHERE endpoint = ?1",
            [&endpoint],
        )
        .map_err(|e| e.to_string())?;
    Ok(deleted as u64)
}

/// 只保留最新 keep 条，返回删除数
#[tauri::command]
pub fn webhook_delivery_prune(
    state: State<'_, DbState>,
    keep: Option<i64>,
) -> Result<u64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let keep = keep.unwrap_or(20).max(0);
    let deleted = conn
        .execute(
            "DELETE FROM webhook_delivery
             WHERE id NOT IN (SELECT id FROM webhook_delivery ORDER BY id DESC LIMIT ?1)",
            [keep],
        )
        .map_err(|e| e.to_string())?;
    Ok(deleted as u64)
}
