//! 应用状态持久化：SQLite KV 存储。
//! 数据库文件位于 app data 目录下 state.db，单表 kv(key, value)，
//! 前端通过 kv_get / kv_set 命令读写（value 为字符串，前端可自行 JSON 序列化）。

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use tauri::{AppHandle, Manager, State};

pub struct DbState(pub(crate) Mutex<Connection>);

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create data dir: {e}"))?;
    let conn = Connection::open(dir.join("state.db"))
        .map_err(|e| format!("failed to open state.db: {e}"))?;
    // 迭代 3b：WAL + 宽松同步。默认回滚日志模式下每条写都 fsync——持久化
    // 路径每个流式 turn 至少一次 sessionTouch（updated_at），等于持续 fsync
    // 尖峰。WAL 把提交变成追加、checkpoint 处批量落盘；journal_mode 持久化
    // 在库文件头，synchronous/busy_timeout 为连接级、每次打开都设。
    // （sidecar local 模式早已 WAL，此处对齐，见 hostdb.ts）
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("failed to set journal_mode: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("failed to set synchronous: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("failed to set busy_timeout: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("failed to init kv table: {e}"))?;
    Ok(conn)
}

/// 在 setup 阶段初始化数据库并注册到应用状态
pub fn init(app: &AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    // pi-agent 业务表（会话索引/凭据/自定义提供商/模型过滤）也在本库，Rust 是唯一写入方
    crate::data::init_tables(&conn)?;
    app.manage(DbState(Mutex::new(conn)));
    Ok(())
}

#[tauri::command]
pub fn kv_get(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let value = conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [&key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value)
}

#[tauri::command]
pub fn kv_set(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&key, &value],
    )
    .map_err(|e| format!("failed to write kv: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn kv_delete(state: State<'_, DbState>, key: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM kv WHERE key = ?1", [&key])
        .map_err(|e| format!("failed to delete kv: {e}"))?;
    Ok(())
}

/// 非 command 场景的全局 kv 读取（如 remote.rs 通过 AppHandle 访问）
pub fn kv_get_global(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 非 command 场景的全局 kv 写入
pub fn kv_set_global(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| format!("failed to write kv: {e}"))?;
    Ok(())
}

/// 非 command 场景的全局 kv 删除
pub fn kv_delete_global(app: &AppHandle, key: &str) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM kv WHERE key = ?1", [key])
        .map_err(|e| format!("failed to delete kv: {e}"))?;
    Ok(())
}
