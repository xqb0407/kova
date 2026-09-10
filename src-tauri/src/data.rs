//! pi-agent 业务数据层：会话索引 / 凭据 / 自定义提供商 / 模型过滤。
//! 这四张表此前由 sidecar（bun:sqlite）建在 state.db 里，与 store.rs 的 kv
//! 共用同一个文件（双进程双驱动共写）。现统一收编到 Rust：schema 与迁移
//! 从 sidecar storage.ts 平移过来，sidecar 通过 stdout 上的 host_query
//! RPC 读写（见 pi_agent.rs 分发）。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// 建表与旧库迁移（schema 与 sidecar storage.ts 保持一致）。
/// 由 store::init 在打开连接后调用。
pub fn init_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pi_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            first_message TEXT NOT NULL DEFAULT '',
            cwd TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credentials (
            provider TEXT PRIMARY KEY,
            api_key TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS custom_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            models TEXT NOT NULL DEFAULT '[]',
            api TEXT NOT NULL DEFAULT 'openai-chat'
        );
        CREATE TABLE IF NOT EXISTS provider_models (
            provider TEXT PRIMARY KEY,
            models TEXT NOT NULL DEFAULT '[]'
        );",
    )
    .map_err(|e| format!("failed to init agent tables: {e}"))?;

    // 旧库迁移：custom_providers 补 api / enabled 列（已存在则忽略）
    let _ = conn.execute_batch(
        "ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE custom_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;",
    );

    // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成用户主目录；统一清空。
    let home = home_dir();
    if let Some(home) = home {
        let _ = conn.execute(
            "UPDATE pi_sessions SET cwd = '' WHERE cwd = ?1",
            params![home],
        );
    }
    Ok(())
}

fn home_dir() -> Option<String> {
    // Windows 优先 USERPROFILE，Unix 用 HOME
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/// 处理一条 host_query（kind + params），返回 data 载荷。
/// 查询都很轻（毫秒级），由调用方决定是否放阻塞线程。
pub fn handle_host_query(
    conn: &Connection,
    kind: &str,
    p: &Value,
) -> Result<Value, String> {
    match kind {
        "session_get" => {
            let id = str_param(p, "sessionId")?;
            let cwd = conn
                .query_row(
                    "SELECT cwd FROM pi_sessions WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(match cwd {
                Some(cwd) => json!({ "cwd": cwd }),
                None => Value::Null,
            })
        }
        "session_insert" => {
            let id = str_param(p, "sessionId")?;
            let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            let now = str_param(p, "now")?;
            conn.execute(
                "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
                params![id, cwd, now, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_list" => {
            let rows = conn
                .prepare("SELECT id, title, first_message, cwd, updated_at FROM pi_sessions ORDER BY updated_at DESC")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "first_message": row.get::<_, String>(2)?,
                        "cwd": row.get::<_, String>(3)?,
                        "updated_at": row.get::<_, String>(4)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "session_delete" => {
            let id = str_param(p, "sessionId")?;
            conn.execute("DELETE FROM pi_sessions WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_rename" => {
            let id = str_param(p, "sessionId")?;
            let name = str_param(p, "name")?;
            conn.execute(
                "UPDATE pi_sessions SET title = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_touch" => {
            // persist 里的增量维护：updated_at 总是更新；title/first_message 仅在为空时回填
            let id = str_param(p, "sessionId")?;
            let now = str_param(p, "now")?;
            let title = p.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let first_message = p.get("firstMessage").and_then(|v| v.as_str()).unwrap_or("");
            conn.execute(
                "UPDATE pi_sessions SET updated_at = ?1, \
                 title = CASE WHEN title = '' THEN ?2 ELSE title END, \
                 first_message = CASE WHEN first_message = '' THEN ?3 ELSE first_message END \
                 WHERE id = ?4",
                params![now, title, first_message, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "credential_get" => {
            let provider = str_param(p, "provider")?;
            let key = conn
                .query_row(
                    "SELECT api_key FROM credentials WHERE provider = ?1",
                    params![provider],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(match key {
                Some(api_key) => json!({ "apiKey": api_key }),
                None => Value::Null,
            })
        }
        "credential_list" => {
            let rows = conn
                .prepare("SELECT provider FROM credentials")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(rows))
        }
        "credential_set" => {
            let provider = str_param(p, "provider")?;
            let api_key = str_param(p, "apiKey")?;
            let now = str_param(p, "now")?;
            conn.execute(
                "INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?) \
                 ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
                params![provider, api_key, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "credential_delete" => {
            let provider = str_param(p, "provider")?;
            conn.execute("DELETE FROM credentials WHERE provider = ?1", params![provider])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "custom_providers_list" => {
            let rows = conn
                .prepare("SELECT id, name, base_url, models, api, enabled FROM custom_providers")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "baseUrl": row.get::<_, String>(2)?,
                        "models": row.get::<_, String>(3)?,
                        "api": row.get::<_, String>(4)?,
                        "enabled": row.get::<_, i64>(5)? == 1,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "custom_provider_get" => {
            let id = str_param(p, "id")?;
            let row = conn
                .query_row(
                    "SELECT id, name, base_url, models, api, enabled FROM custom_providers WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "name": row.get::<_, String>(1)?,
                            "baseUrl": row.get::<_, String>(2)?,
                            "models": row.get::<_, String>(3)?,
                            "api": row.get::<_, String>(4)?,
                            "enabled": row.get::<_, i64>(5)? == 1,
                        }))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(row.unwrap_or(Value::Null))
        }
        "custom_provider_upsert" => {
            let id = str_param(p, "id")?;
            let name = str_param(p, "name")?;
            let base_url = str_param(p, "baseUrl")?;
            let models = str_param(p, "models")?;
            let api = str_param(p, "api")?;
            conn.execute(
                "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, \
                 models = excluded.models, api = excluded.api",
                params![id, name, base_url, models, api],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "custom_provider_delete" => {
            let id = str_param(p, "id")?;
            conn.execute("DELETE FROM custom_providers WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "custom_provider_set_enabled" => {
            let id = str_param(p, "id")?;
            let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            conn.execute(
                "UPDATE custom_providers SET enabled = ?1 WHERE id = ?2",
                params![enabled, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "provider_models_all" => {
            let rows = conn
                .prepare("SELECT provider, models FROM provider_models")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "provider": row.get::<_, String>(0)?,
                        "models": row.get::<_, String>(1)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "provider_models_get" => {
            let provider = str_param(p, "provider")?;
            let models = conn
                .query_row(
                    "SELECT models FROM provider_models WHERE provider = ?1",
                    params![provider],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(match models {
                Some(models) => json!({ "models": models }),
                None => Value::Null,
            })
        }
        "provider_models_set" => {
            let provider = str_param(p, "provider")?;
            let models = str_param(p, "models")?;
            // 空数组 = 清除过滤，恢复全部
            if models == "[]" {
                conn.execute("DELETE FROM provider_models WHERE provider = ?1", params![provider])
                    .map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO provider_models (provider, models) VALUES (?, ?) \
                     ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
                    params![provider, models],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(json!({}))
        }
        _ => {
            // 工具执行（阶段②）：bash/read/write/edit 由 Rust 直接执行
            // p = { name, cwd, params: {...} }，handle_tool 自己解包内层 params
            if kind == "tool" {
                return crate::tool_exec::handle_tool(p);
            }
            Err(format!("unknown host_query kind: {kind}"))
        }
    }
}

/// 供 pi_agent.rs 调用的入口：从 store 的连接互斥锁执行查询。
pub fn dispatch_host_query(db: &std::sync::Mutex<Connection>, msg: &Value) -> Value {
    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let result = (|| -> Result<Value, String> {
        let kind = msg
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or("missing kind")?;
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let conn = db.lock().map_err(|e| format!("db poisoned: {e}"))?;
        handle_host_query(&conn, kind, &params)
    })();
    match result {
        Ok(data) => json!({ "type": "host_result", "id": id, "ok": true, "data": data }),
        Err(err) => json!({ "type": "host_result", "id": id, "ok": false, "error": err }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：kind="tool" 必须把整个 { name, cwd, params } 传给 handle_tool，
    /// 不能只传内层 params（曾导致 "missing param: name"）。
    #[test]
    fn tool_kind_passes_full_envelope() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let msg = json!({
            "id": "req-1",
            "kind": "tool",
            "params": {
                "name": "read",
                "cwd": ".",
                "params": { "file_path": "definitely/missing/file.txt" }
            }
        });
        let result = dispatch_host_query(&std::sync::Mutex::new(conn), &msg);
        assert_eq!(result["id"], "req-1");
        // 读文件失败是 io 错误（ok=false），但绝不能是 "missing param: name"
        let err = result["error"].as_str().unwrap_or_default();
        if result["ok"] != json!(true) {
            assert!(!err.contains("missing param"), "unexpected error: {err}");
        }
    }
}
