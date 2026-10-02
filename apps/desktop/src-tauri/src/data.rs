//! pi-agent 业务数据层：会话索引（sessions）/ 凭据（credentials）/ 自定义提供商
//! （custom_providers）/ 模型目录（models）。这四张表此前由 sidecar（bun:sqlite）
//! 建在 state.db 里，与 store.rs 的 kv 共用同一个文件（双进程双驱动共写）。
//! 现统一收编到 Rust：schema 与迁移从 sidecar storage.ts 平移过来，sidecar 通过
//! stdout 上的 host_query RPC 读写（见 pi_agent.rs 分发）。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// 建表与旧库迁移（schema 与 sidecar hostdb.ts 保持一致）。
/// 由 store::init 在打开连接后调用。
pub fn init_tables(conn: &Connection) -> Result<(), String> {
    // 旧表重命名（去掉 pi_ 前缀）：旧表存在且新表不存在时生效，否则忽略。
    // 必须在 CREATE TABLE 之前执行，避免新表先建出来挡住重命名。
    let _ = conn.execute("ALTER TABLE pi_sessions RENAME TO sessions", []);
    let _ = conn.execute("ALTER TABLE pi_models RENAME TO models", []);

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            first_message TEXT NOT NULL DEFAULT '',
            cwd TEXT NOT NULL DEFAULT '',
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            message_count INTEGER
        );
        CREATE TABLE IF NOT EXISTS credentials (
            provider TEXT PRIMARY KEY,
            api_key TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secrets (
            name TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'global',
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (name, scope)
        );
        CREATE TABLE IF NOT EXISTS custom_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            models TEXT NOT NULL DEFAULT '[]',
            api TEXT NOT NULL DEFAULT 'openai-chat'
        );
        CREATE TABLE IF NOT EXISTS models (
            provider TEXT NOT NULL,
            model_id TEXT NOT NULL,
            name TEXT,
            reasoning INTEGER,
            context_window INTEGER,
            max_tokens INTEGER,
            input_json TEXT,
            cost_json TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (provider, model_id)
        );
        CREATE TABLE IF NOT EXISTS usage_daily (
            session_id TEXT NOT NULL,
            date TEXT NOT NULL,
            input INTEGER NOT NULL DEFAULT 0,
            output INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0,
            tokens INTEGER NOT NULL DEFAULT 0,
            messages INTEGER NOT NULL DEFAULT 0,
            by_model TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (session_id, date)
        );
        CREATE TABLE IF NOT EXISTS usage_scan (
            session_id TEXT PRIMARY KEY,
            mtime REAL NOT NULL,
            first_ts INTEGER NOT NULL DEFAULT 0,
            last_ts INTEGER NOT NULL DEFAULT 0
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

    // 旧库迁移：sessions 补 archived 列（已存在则忽略）
    let _ = conn.execute_batch(
        "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    );

    // 迭代 4：sessions 补 message_count 列（可空：NULL = 未回填，由
    // backfill_message_counts 在启动时按 JSONL 消息行数补数）。
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN message_count INTEGER;");

    // 会话级偏好：mode / approval_level（agent|plan、ask|auto-edit|auto）与
    // 最近一次随会话运行的模型。NULL = 从未变更过（打开时回落全局默认）。
    // 由 sidecar 在 set_mode / set_model / 模式状态机变更时经 session_prefs_set 写入。
    // design_theme：设计主题 JSON 字符串 {scope,id}；NULL = 从未选中（回落最近使用），
    // "" = 显式不使用主题（sidecar 的 set_design_theme 维护，见 pi-agent/src/design-md/）。
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN mode TEXT;");
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN approval_level TEXT;");
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN model_provider TEXT;");
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN model_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN thinking_level TEXT;");
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN design_theme TEXT;");
    // app_mode：会话级工作模式（work|code|design）。NULL = 本会话从未切换过模式，
    // 跟随全局默认（kv pi.app_mode）；定靶 set_app_mode 只写被点名会话这一列，
    // 其余会话不受波及（与 thinking_level 同型，见 pi-agent handlers/preferences.ts）。
    let _ = conn.execute_batch("ALTER TABLE sessions ADD COLUMN app_mode TEXT;");

    // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成用户主目录；统一清空。
    let home = home_dir();
    if let Some(home) = home {
        let _ = conn.execute(
            "UPDATE sessions SET cwd = '' WHERE cwd = ?1",
            params![home],
        );
    }

    // 旧数据迁移：custom_providers.models JSON 列 → models 行。
    // 迁移完成后该列清空为 '[]'（幂等标记），新数据只写 models。
    migrate_custom_provider_models(conn)?;

    // 旧数据迁移：provider_models（pi_models 出现前的过滤白名单，JSON string[]）
    // → models 行，搬完删表。
    migrate_provider_model_filters(conn)?;

    // 兜底：若旧 pi_* 表仍在（如新表先被别的版本建出、重命名没成功），把行并入新表后删壳。
    drain_legacy_table(
        conn,
        "pi_sessions",
        "sessions",
        "id, title, first_message, cwd, created_at, updated_at",
    )?;
    drain_legacy_table(
        conn,
        "pi_models",
        "models",
        "provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled",
    )?;
    Ok(())
}

/// 迭代 4（P4）：为 message_count 为 NULL 的旧行一次性回填 JSONL 消息行数。
/// 口径与旧 list_sessions 的扫文件计数一致（含 `"type":"message"` 的行数）；
/// 回填后该行永不再读文件（运行期由 session_touch 增量维护）。
/// 仅在升级后的首个启动发生 I/O；store.rs init 在 setup 里同步调用。
pub fn backfill_message_counts(
    conn: &Connection,
    sessions_dir: &std::path::Path,
) -> Result<(), String> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM sessions WHERE message_count IS NULL")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        let count = match std::fs::read_to_string(sessions_dir.join(format!("{id}.jsonl"))) {
            Ok(content) => content
                .lines()
                .filter(|line| line.contains("\"type\":\"message\""))
                .count() as i64,
            // 文件缺失：等价于旧扫描的 existsSync=false ⇒ 0（列表按 >0 过滤，自然隐藏）
            Err(_) => 0,
        };
        let _ = conn.execute(
            "UPDATE sessions SET message_count = ?1 WHERE id = ?2 AND message_count IS NULL",
            params![count, id],
        );
    }
    Ok(())
}

/// 把 custom_providers.models（CustomModelSpec[] JSON）搬进 models（enabled=1）。
/// 只处理 models != '[]' 的行；搬完把该列置 '[]'，重复执行无副作用。
fn migrate_custom_provider_models(conn: &Connection) -> Result<(), String> {
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, models FROM custom_providers WHERE models != '[]'")
        .and_then(|mut s| {
            s.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map(|it| it.filter_map(|r| r.ok()).collect())
        })
        .map_err(|e| format!("read custom_providers for model migration: {e}"))?;
    for (id, models_json) in rows {
        let specs: Vec<Value> = serde_json::from_str(&models_json).unwrap_or_default();
        for spec in specs {
            let Some(model_id) = spec.get("id").and_then(Value::as_str) else {
                continue;
            };
            if model_id.trim().is_empty() {
                continue;
            }
            let name = spec.get("name").and_then(Value::as_str);
            let reasoning = spec.get("reasoning").and_then(Value::as_bool);
            let context_window = spec
                .get("contextWindow")
                .and_then(Value::as_i64)
                .or_else(|| spec.get("contextWindow").and_then(Value::as_f64).map(|f| f as i64));
            let max_tokens = spec
                .get("maxTokens")
                .and_then(Value::as_i64)
                .or_else(|| spec.get("maxTokens").and_then(Value::as_f64).map(|f| f as i64));
            let input_json = match spec.get("input") {
                Some(v) if v.is_array() => Some(v.to_string()),
                _ => None,
            };
            let cost_json = match spec.get("cost") {
                Some(v) if v.is_object() => Some(v.to_string()),
                _ => None,
            };
            if let Err(e) = conn.execute(
                "INSERT OR REPLACE INTO models \
                 (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
                params![id, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json],
            ) {
                return Err(format!("migrate custom provider model {id}/{model_id}: {e}"));
            }
        }
        if let Err(e) = conn.execute(
            "UPDATE custom_providers SET models = '[]' WHERE id = ?1",
            params![id],
        ) {
            return Err(format!("clear migrated models column for {id}: {e}"));
        }
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

/// 旧表 provider_models（早期版本的过滤白名单，models 列为 JSON string[]）→ models 行。
/// 只迁移 models 表里没有该 provider 行的记录（新数据优先）；搬完删表。幂等。
fn migrate_provider_model_filters(conn: &Connection) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'provider_models'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(|e| format!("check provider_models exists: {e}"))?;
    if !exists {
        return Ok(());
    }
    let rows: Vec<(String, String)> = conn
        .prepare(
            "SELECT provider, models FROM provider_models \
             WHERE models != '[]' AND provider NOT IN (SELECT DISTINCT provider FROM models)",
        )
        .and_then(|mut s| {
            s.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map(|it| it.filter_map(|r| r.ok()).collect())
        })
        .map_err(|e| format!("read provider_models for filter migration: {e}"))?;
    for (provider, models_json) in rows {
        let ids: Vec<String> = serde_json::from_str(&models_json).unwrap_or_default();
        for model_id in ids {
            if model_id.trim().is_empty() {
                continue;
            }
            if let Err(e) = conn.execute(
                "INSERT OR IGNORE INTO models (provider, model_id, enabled) VALUES (?, ?, 1)",
                params![provider, model_id],
            ) {
                return Err(format!("migrate provider filter {provider}/{model_id}: {e}"));
            }
        }
    }
    conn.execute("DROP TABLE provider_models", [])
        .map_err(|e| format!("drop provider_models: {e}"))?;
    Ok(())
}

/// 旧 pi_* 表未被重命名成功（新表已存在）时，把行并入新表后删除旧表。幂等。
/// columns 为两表共有的列清单（显式列出，不依赖列序）。
fn drain_legacy_table(
    conn: &Connection,
    legacy: &str,
    target: &str,
    columns: &str,
) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![legacy],
            |r| r.get(0),
        )
        .map_err(|e| format!("check {legacy} exists: {e}"))?;
    if exists == 0 {
        return Ok(());
    }
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO {target} ({columns}) SELECT {columns} FROM {legacy}"
        ),
        [],
    )
    .map_err(|e| format!("drain {legacy} into {target}: {e}"))?;
    conn.execute(&format!("DROP TABLE {legacy}"), [])
        .map_err(|e| format!("drop {legacy}: {e}"))?;
    Ok(())
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/* ------------------------------- 密钥库辅助 ------------------------------- */

/// 单个密钥值上限：密钥是 token 级的短串，8KB 足够且防滥用
pub const MAX_SECRET_VALUE_BYTES: usize = 8 * 1024;

/// 密钥名规则：它将成为环境变量名，与 MCP 的 ENV_KEY_RE 同款
/// （sidecar/mcp-config.ts），字母/下划线开头。
pub fn is_valid_secret_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    name.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 作用域：global（全局）或 workspace:<cwd>（按工作区隔离，覆盖同名全局项）
pub fn is_valid_secret_scope(scope: &str) -> bool {
    scope == "global" || (scope.starts_with("workspace:") && scope.len() > "workspace:".len())
}

/// 掩码规则与 provider key 一致（payloads.ts）：`****` + 后四位
fn mask_secret(plain: &str) -> String {
    if plain.chars().count() > 4 {
        let tail: String = plain.chars().skip(plain.chars().count() - 4).collect();
        format!("****{tail}")
    } else {
        "****".to_string()
    }
}

/// 查询 models 行（None = 全部 provider）。attrs 列可空（NULL = 继承内置值），
/// input_json/cost_json 在此解析为结构化 JSON 返回。
fn models_query(conn: &Connection, provider: Option<String>) -> Result<Value, String> {
    let sql = "SELECT provider, model_id, name, reasoning, context_window, max_tokens, \
               input_json, cost_json, enabled FROM models";
    let map_row = |row: &rusqlite::Row| -> Result<Value, rusqlite::Error> {
        let input_json: Option<String> = row.get(6)?;
        let cost_json: Option<String> = row.get(7)?;
        Ok(json!({
            "provider": row.get::<_, String>(0)?,
            "modelId": row.get::<_, String>(1)?,
            "name": row.get::<_, Option<String>>(2)?,
            "reasoning": row.get::<_, Option<bool>>(3)?,
            "contextWindow": row.get::<_, Option<i64>>(4)?,
            "maxTokens": row.get::<_, Option<i64>>(5)?,
            "input": input_json
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v.is_array()),
            "cost": cost_json
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v.is_object()),
            "enabled": row.get::<_, i64>(8)? == 1,
        }))
    };
    let rows = match provider {
        Some(p) => conn
            .prepare(&format!("{sql} WHERE provider = ?1 ORDER BY model_id"))
            .and_then(|mut s| {
                s.query_map(params![p], map_row)
                    .map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
            }),
        None => conn
            .prepare(&format!("{sql} ORDER BY provider, model_id"))
            .and_then(|mut s| {
                s.query_map([], map_row)
                    .map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
            }),
    }
    .map_err(|e| e.to_string())?;
    Ok(Value::Array(rows))
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
            let row = conn
                .query_row(
                    "SELECT cwd, title, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode FROM sessions WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok(json!({
                            "cwd": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "mode": row.get::<_, Option<String>>(2)?,
                            "approvalLevel": row.get::<_, Option<String>>(3)?,
                            "modelProvider": row.get::<_, Option<String>>(4)?,
                            "modelId": row.get::<_, Option<String>>(5)?,
                            "thinkingLevel": row.get::<_, Option<String>>(6)?,
                            "designTheme": row.get::<_, Option<String>>(7)?,
                            "appMode": row.get::<_, Option<String>>(8)?,
                        }))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(row.unwrap_or(Value::Null))
        }
        "session_insert" => {
            let id = str_param(p, "sessionId")?;
            let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            let now = str_param(p, "now")?;
            conn.execute(
                "INSERT INTO sessions (id, title, first_message, cwd, created_at, updated_at, message_count) VALUES (?, '', '', ?, ?, ?, 0)",
                params![id, cwd, now, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_list" => {
            let rows = conn
                .prepare("SELECT id, title, first_message, cwd, archived, updated_at, message_count, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode FROM sessions ORDER BY updated_at DESC")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "first_message": row.get::<_, String>(2)?,
                        "cwd": row.get::<_, String>(3)?,
                        "archived": row.get::<_, i64>(4)?,
                        "updated_at": row.get::<_, String>(5)?,
                        // NULL = 启动回填尚未覆盖（理论不可达），按 0 呈现
                        "message_count": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        "mode": row.get::<_, Option<String>>(7)?,
                        "approvalLevel": row.get::<_, Option<String>>(8)?,
                        "modelProvider": row.get::<_, Option<String>>(9)?,
                        "modelId": row.get::<_, Option<String>>(10)?,
                        "thinkingLevel": row.get::<_, Option<String>>(11)?,
                        "designTheme": row.get::<_, Option<String>>(12)?,
                        "appMode": row.get::<_, Option<String>>(13)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "session_delete" => {
            let id = str_param(p, "sessionId")?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_rename" => {
            let id = str_param(p, "sessionId")?;
            let name = str_param(p, "name")?;
            conn.execute(
                "UPDATE sessions SET title = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_set_archived" => {
            let id = str_param(p, "sessionId")?;
            let archived = p.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
            conn.execute(
                "UPDATE sessions SET archived = ?1 WHERE id = ?2",
                params![if archived { 1 } else { 0 }, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_update_cwd" => {
            // 补绑工作目录：建会话时未选目录、后来选了（见 sessions.ts rebindRunCwd）
            let id = str_param(p, "sessionId")?;
            let cwd = str_param(p, "cwd")?;
            conn.execute("UPDATE sessions SET cwd = ?1 WHERE id = ?2", params![cwd, id])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_touch" => {
            // persist 里的增量维护：updated_at 总是更新；title/first_message 仅在为空时回填；
            // 迭代 4：顺带累加本轮新写入 JSONL 的消息行数（added），列表不再扫文件
            let id = str_param(p, "sessionId")?;
            let now = str_param(p, "now")?;
            let title = p.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let first_message = p.get("firstMessage").and_then(|v| v.as_str()).unwrap_or("");
            let added = p.get("added").and_then(|v| v.as_i64()).unwrap_or(0);
            conn.execute(
                "UPDATE sessions SET updated_at = ?1, \
                 title = CASE WHEN title = '' THEN ?2 ELSE title END, \
                 first_message = CASE WHEN first_message = '' THEN ?3 ELSE first_message END, \
                 message_count = COALESCE(message_count, 0) + ?5 \
                 WHERE id = ?4",
                params![now, title, first_message, id, added],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "session_prefs_set" => {
            // 会话级偏好写入（sidecar 在 set_mode / set_model / set_design_theme /
            // 模式状态机变更时调用）：只更新携带的字段，未携带的保持原值（COALESCE 语义）。
            // design_theme：JSON 字符串 = 选中主题；"" = 显式不使用主题（仍是携带的更新值）
            let id = str_param(p, "sessionId")?;
            let mode = p.get("mode").and_then(|v| v.as_str());
            let approval_level = p.get("approvalLevel").and_then(|v| v.as_str());
            let model_provider = p.get("modelProvider").and_then(|v| v.as_str());
            let model_id = p.get("modelId").and_then(|v| v.as_str());
            let thinking_level = p.get("thinkingLevel").and_then(|v| v.as_str());
            let design_theme = p.get("designTheme").and_then(|v| v.as_str());
            let app_mode = p.get("appMode").and_then(|v| v.as_str());
            conn.execute(
                "UPDATE sessions SET \
                 mode = COALESCE(?2, mode), \
                 approval_level = COALESCE(?3, approval_level), \
                 model_provider = COALESCE(?4, model_provider), \
                 model_id = COALESCE(?5, model_id), \
                 thinking_level = COALESCE(?6, thinking_level), \
                 design_theme = COALESCE(?7, design_theme), \
                 app_mode = COALESCE(?8, app_mode) \
                 WHERE id = ?1",
                params![id, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode],
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
                // 密文解密失败（换机/主密钥丢失）按"无凭据"处理，用户重输即可
                Some(stored) => match crate::secret::decrypt(&stored) {
                    Ok(api_key) => json!({ "apiKey": api_key }),
                    Err(e) => {
                        log::warn!("[data] credential decrypt failed for {provider}: {e}");
                        Value::Null
                    }
                },
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
            let api_key = crate::secret::encrypt(&str_param(p, "apiKey")?);
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
        // ------------------------------- 密钥库 -------------------------------
        // 值明文落盘（secret::encrypt 已是直通，见该模块「当前不加密」的说明），
        // 本层**不提供 secret_get**：只有 secret_list 回掩码，明文没有 RPC 出口。
        // 见 docs/secrets-env-design.md。
        "secret_list" => {
            let rows = conn
                .prepare("SELECT name, scope, value, updated_at FROM secrets ORDER BY name, scope")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    let value: String = row.get(2)?;
                    // 解密只为算掩码，明文随即丢弃；解不开（换机/主密钥丢失）
                    // 不报错也不外泄，标 readable=false 交给 UI 提示"需重填"
                    let masked = match crate::secret::decrypt(&value) {
                        Ok(plain) => (mask_secret(&plain), true),
                        Err(_) => ("****".to_string(), false),
                    };
                    Ok(json!({
                        "name": row.get::<_, String>(0)?,
                        "scope": row.get::<_, String>(1)?,
                        "masked": masked.0,
                        "readable": masked.1,
                        "updatedAt": row.get::<_, String>(3)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "secret_set" => {
            let name = str_param(p, "name")?;
            if !is_valid_secret_name(&name) {
                return Err(
                    "secret name must match [A-Za-z_][A-Za-z0-9_]* (it becomes an env var name)"
                        .into(),
                );
            }
            let scope = p.get("scope").and_then(|v| v.as_str()).unwrap_or("global");
            if !is_valid_secret_scope(scope) {
                return Err("secret scope must be \"global\" or \"workspace:<cwd>\"".into());
            }
            let value = str_param(p, "value")?;
            if value.is_empty() {
                return Err("secret value is required".into());
            }
            if value.len() > MAX_SECRET_VALUE_BYTES {
                return Err(format!(
                    "secret value too large ({} bytes > {MAX_SECRET_VALUE_BYTES})",
                    value.len()
                ));
            }
            let now = str_param(p, "now")?;
            conn.execute(
                "INSERT INTO secrets (name, scope, value, updated_at) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(name, scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![name, scope, crate::secret::encrypt(&value), now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "secret_delete" => {
            let name = str_param(p, "name")?;
            let scope = p.get("scope").and_then(|v| v.as_str()).unwrap_or("global");
            conn.execute(
                "DELETE FROM secrets WHERE name = ?1 AND scope = ?2",
                params![name, scope],
            )
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
        "models_all" => models_query(conn, None),
        "models_list" => {
            let provider = str_param(p, "provider")?;
            models_query(conn, Some(provider))
        }
        "models_replace" => {
            // 整包替换该 provider 的模型行：items = [{modelId, enabled, name?, reasoning?,
            // contextWindow?, maxTokens?, input?, cost?}]，attrs 缺省 = NULL（继承内置值）
            let provider = str_param(p, "provider")?;
            let items = str_param(p, "models")?;
            let items: Vec<Value> =
                serde_json::from_str(&items).map_err(|e| format!("parse models: {e}"))?;
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM models WHERE provider = ?1", params![provider])
                .map_err(|e| e.to_string())?;
            for item in items {
                let Some(model_id) = item.get("modelId").and_then(Value::as_str) else {
                    continue;
                };
                if model_id.trim().is_empty() {
                    continue;
                }
                let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                let name = item.get("name").and_then(Value::as_str);
                let reasoning = item.get("reasoning").and_then(Value::as_bool);
                let context_window = item.get("contextWindow").and_then(Value::as_i64);
                let max_tokens = item.get("maxTokens").and_then(Value::as_i64);
                let input_json = item.get("input").filter(|v| v.is_array()).map(Value::to_string);
                let cost_json = item.get("cost").filter(|v| v.is_object()).map(Value::to_string);
                tx.execute(
                    "INSERT OR REPLACE INTO models \
                     (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "models_delete_provider" => {
            let provider = str_param(p, "provider")?;
            conn.execute("DELETE FROM models WHERE provider = ?1", params![provider])
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        // 应用级 kv（个性化设置等）：表由 store.rs 建在本库，sidecar 经此读写整包 JSON
        "kv_get" => {
            let key = str_param(p, "key")?;
            let value = conn
                .query_row(
                    "SELECT value FROM kv WHERE key = ?1",
                    params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(match value {
                Some(value) => json!({ "value": value }),
                None => Value::Null,
            })
        }
        "kv_set" => {
            let key = str_param(p, "key")?;
            let value = str_param(p, "value")?;
            conn.execute(
                "INSERT INTO kv(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("failed to write kv: {e}"))?;
            Ok(json!({}))
        }
        // 使用统计物化表（转录为事实源，此处为增量维护的聚合缓存）
        "usage_scan_list" => {
            let rows = conn
                .prepare("SELECT session_id, mtime, first_ts, last_ts FROM usage_scan")
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "sessionId": row.get::<_, String>(0)?,
                        "mtime": row.get::<_, f64>(1)?,
                        "firstTs": row.get::<_, i64>(2)?,
                        "lastTs": row.get::<_, i64>(3)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "usage_daily_replace" => {
            // 整会话替换（幂等）：删该会话旧行 → 插新行 → upsert 扫描水位（mtime/跨度）
            let session_id = str_param(p, "sessionId")?;
            let mtime = p
                .get("mtime")
                .and_then(Value::as_f64)
                .ok_or("missing mtime")?;
            let first_ts = p.get("firstTs").and_then(Value::as_i64).unwrap_or(0);
            let last_ts = p.get("lastTs").and_then(Value::as_i64).unwrap_or(0);
            let items: Vec<Value> = serde_json::from_str(&str_param(p, "rows")?)
                .map_err(|e| format!("parse rows: {e}"))?;
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM usage_daily WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|e| e.to_string())?;
            for item in &items {
                tx.execute(
                    "INSERT INTO usage_daily \
                     (session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        session_id,
                        item.get("date").and_then(Value::as_str).unwrap_or(""),
                        item.get("input").and_then(Value::as_i64).unwrap_or(0),
                        item.get("output").and_then(Value::as_i64).unwrap_or(0),
                        item.get("cacheRead").and_then(Value::as_i64).unwrap_or(0),
                        item.get("cacheWrite").and_then(Value::as_i64).unwrap_or(0),
                        item.get("tokens").and_then(Value::as_i64).unwrap_or(0),
                        item.get("messages").and_then(Value::as_i64).unwrap_or(0),
                        item.get("byModel").and_then(Value::as_str).unwrap_or("{}"),
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute(
                "INSERT INTO usage_scan (session_id, mtime, first_ts, last_ts) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime, \
                 first_ts = excluded.first_ts, last_ts = excluded.last_ts",
                params![session_id, mtime, first_ts, last_ts],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "usage_daily_query" => {
            let rows = conn
                .prepare(
                    "SELECT session_id, date, input, output, cache_read, cache_write, \
                     tokens, messages, by_model FROM usage_daily ORDER BY date",
                )
                .map_err(|e| e.to_string())?
                .query_map([], |row| {
                    Ok(json!({
                        "sessionId": row.get::<_, String>(0)?,
                        "date": row.get::<_, String>(1)?,
                        "input": row.get::<_, i64>(2)?,
                        "output": row.get::<_, i64>(3)?,
                        "cacheRead": row.get::<_, i64>(4)?,
                        "cacheWrite": row.get::<_, i64>(5)?,
                        "tokens": row.get::<_, i64>(6)?,
                        "messages": row.get::<_, i64>(7)?,
                        "byModel": row.get::<_, String>(8)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(rows))
        }
        "usage_daily_cleanup" => {
            // 索引表中已删除的会话：其聚合行与扫描水位一并清除，返回清理数
            let removed = conn
                .execute(
                    "DELETE FROM usage_daily WHERE session_id NOT IN (SELECT id FROM sessions)",
                    [],
                )
                .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM usage_scan WHERE session_id NOT IN (SELECT id FROM sessions)",
                [],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "removed": removed }))
        }
        _ => Err(format!("unknown host_query kind: {kind}")),
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
        // 工具执行（阶段②）：bash/read/write/edit 由 Rust 直接执行。
        // p = { name, cwd, params: {...} }，handle_tool 自己解包内层 params。
        // 注意：不进 db 锁——长 bash 期间不阻塞其他 host_query，且 id 登记进
        // 在飞表后 sidecar 的 host_cancel{id} 可随时杀掉对应进程树。
        if kind == "tool" {
            let mut envelope = params;
            // 密钥注入：sidecar 只送名字（p.secretEnv），这里短暂持锁解成明文写进
            // p.secretEnvResolved，明文不跨 RPC 边界、不进长命令的锁窗口。
            // 无 secretEnv 时零开销（不取锁），行为与从前一致。
            crate::secret_env::resolve_into_envelope(db, &mut envelope);
            return crate::tool_exec::handle_tool(&id, &envelope);
        }
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

    /// custom_providers.models JSON 列迁移到 models：一次搬净、幂等、列清空。
    #[test]
    fn custom_provider_models_migrate_to_models() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES \
             ('custom-proxy', 'Proxy', 'https://x/v1', \
              '[{\"id\":\"m1\",\"name\":\"M1\",\"contextWindow\":32000,\"reasoning\":true},{\"id\":\"m2\"}]', \
              'openai-chat')",
            [],
        )
        .unwrap();
        migrate_custom_provider_models(&conn).unwrap();
        let all = models_query(&conn, None).unwrap();
        let arr = all.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        let m1 = arr.iter().find(|r| r["modelId"] == "m1").unwrap();
        assert_eq!(m1["provider"], "custom-proxy");
        assert_eq!(m1["name"], "M1");
        assert_eq!(m1["contextWindow"], 32000);
        assert_eq!(m1["reasoning"], true);
        assert_eq!(m1["enabled"], true);
        let m2 = arr.iter().find(|r| r["modelId"] == "m2").unwrap();
        assert_eq!(m2["name"], Value::Null);
        // 迁移后列清空；再跑一遍不产生重复
        assert_eq!(
            conn.query_row(
                "SELECT models FROM custom_providers WHERE id = 'custom-proxy'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
            "[]"
        );
        migrate_custom_provider_models(&conn).unwrap();
        assert_eq!(models_query(&conn, None).unwrap().as_array().unwrap().len(), 2);
    }

    /// models_replace 整包替换 + models_list 读取（attrs 可空、enabled 缺省 true）。
    #[test]
    fn models_replace_and_list() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(
                &db,
                &json!({ "id": "t", "kind": kind, "params": p }),
            )
        };
        let res = q(
            "models_replace",
            json!({
                "provider": "openai",
                "models": "[{\"modelId\":\"gpt-x\",\"enabled\":false,\"contextWindow\":999,\"input\":[\"text\",\"image\"],\"cost\":{\"input\":1.5,\"output\":3}},{\"modelId\":\"gpt-y\"}]"
            }),
        );
        assert_eq!(res["ok"], true, "replace failed: {res}");
        let list = q("models_list", json!({ "provider": "openai" }));
        assert_eq!(list["ok"], true);
        let rows = list["data"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let gx = rows.iter().find(|r| r["modelId"] == "gpt-x").unwrap();
        assert_eq!(gx["enabled"], false);
        assert_eq!(gx["contextWindow"], 999);
        assert_eq!(gx["input"], json!(["text", "image"]));
        assert_eq!(gx["cost"]["input"], 1.5);
        assert_eq!(gx["name"], Value::Null);
        let gy = rows.iter().find(|r| r["modelId"] == "gpt-y").unwrap();
        assert_eq!(gy["enabled"], true); // 缺省启用
        assert_eq!(gy["cost"], Value::Null);
        // 再次 replace 只保留新集合
        q(
            "models_replace",
            json!({ "provider": "openai", "models": "[{\"modelId\":\"gpt-z\"}]" }),
        );
        let rows = q("models_list", json!({ "provider": "openai" }))["data"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["modelId"], "gpt-z");
    }

    /// 旧库迁移：pi_sessions/pi_models 重命名为 sessions/models（数据保留），
    /// provider_models 过滤白名单搬进 models 后删表；fresh 库无旧表也正常。
    #[test]
    fn legacy_tables_renamed_and_filters_migrated() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟旧库：pi_* 两张表带数据 + provider_models 白名单
        conn.execute_batch(
            "CREATE TABLE pi_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', \
             first_message TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', \
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO pi_sessions (id, created_at, updated_at) VALUES ('s1', 't', 't');
             CREATE TABLE pi_models (provider TEXT NOT NULL, model_id TEXT NOT NULL, name TEXT, \
             reasoning INTEGER, context_window INTEGER, max_tokens INTEGER, input_json TEXT, \
             cost_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (provider, model_id));
             INSERT INTO pi_models (provider, model_id, enabled) VALUES ('openai', 'gpt-old', 1);
             CREATE TABLE provider_models (provider TEXT PRIMARY KEY, models TEXT NOT NULL DEFAULT '[]');
             INSERT INTO provider_models (provider, models) VALUES ('anthropic', '[\"claude-a\",\"claude-b\"]');",
        )
        .unwrap();
        init_tables(&conn).unwrap();
        // 重命名后数据保留
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM models", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3 // gpt-old + claude-a/b
        );
        let enabled: Vec<(String, i64)> = conn
            .prepare("SELECT model_id, enabled FROM models WHERE provider = 'anthropic' ORDER BY model_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(enabled, vec![("claude-a".into(), 1), ("claude-b".into(), 1)]);
        // 旧表已删
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
                 AND name IN ('pi_sessions', 'pi_models', 'provider_models')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
        // 再跑一遍 init_tables 幂等
        init_tables(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM models", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    /// 旧壳残留场景：新表先存在（重命名失败）且旧表里还有数据 → 行并入新表、旧表删除。
    #[test]
    fn legacy_tables_drained_when_new_exists() {
        let conn = Connection::open_in_memory().unwrap();
        // 先按新 schema 建新表并写入一行；再模拟带数据的旧表（重命名会失败）
        init_tables(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s-new', 'new', 't', 't');
             CREATE TABLE pi_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', \
             first_message TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', \
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO pi_sessions (id, title, created_at, updated_at) VALUES ('s-old', 'old', 't', 't');
             CREATE TABLE pi_models (provider TEXT NOT NULL, model_id TEXT NOT NULL, name TEXT, \
             reasoning INTEGER, context_window INTEGER, max_tokens INTEGER, input_json TEXT, \
             cost_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (provider, model_id));
             INSERT INTO pi_models (provider, model_id, enabled) VALUES ('openai', 'gpt-old', 1);",
        )
        .unwrap();
        init_tables(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2); // s-new + s-old 并入
        let has_old: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE id = 's-old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_old, 1);
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
                 AND name IN ('pi_sessions', 'pi_models')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    /// session_set_archived 打标 + session_list 回读；旧库缺 archived 列时迁移补列。
    #[test]
    fn session_archive_flag_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(
                &db,
                &json!({ "id": "t", "kind": kind, "params": p }),
            )
        };
        q("session_insert", json!({ "sessionId": "s1", "cwd": "", "now": "t" }));
        q("session_insert", json!({ "sessionId": "s2", "cwd": "/w", "now": "t" }));

        q("session_set_archived", json!({ "sessionId": "s1", "archived": true }));
        let rows = q("session_list", json!({}))["data"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(rows.len(), 2);
        let s1 = rows.iter().find(|r| r["id"] == "s1").unwrap();
        let s2 = rows.iter().find(|r| r["id"] == "s2").unwrap();
        assert_eq!(s1["archived"], 1);
        assert_eq!(s2["archived"], 0);

        q("session_set_archived", json!({ "sessionId": "s1", "archived": false }));
        let rows = q("session_list", json!({}))["data"]
            .as_array()
            .unwrap()
            .clone();
        let s1 = rows.iter().find(|r| r["id"] == "s1").unwrap();
        assert_eq!(s1["archived"], 0);
    }

    /// session_update_cwd 换绑/解绑往返：解绑写空串必须落库为空
    /// （sidecar set_session_cwd 的"清目录"路径依赖这里能写回 ""）。
    #[test]
    fn session_update_cwd_binds_and_unbinds() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(
                &db,
                &json!({ "id": "t", "kind": kind, "params": p }),
            )
        };
        q("session_insert", json!({ "sessionId": "s1", "cwd": "", "now": "t" }));

        q("session_update_cwd", json!({ "sessionId": "s1", "cwd": "/work/a" }));
        assert_eq!(q("session_get", json!({ "sessionId": "s1" }))["data"]["cwd"], "/work/a");

        // 解绑：空串写回（SQL 无空值短路，UPDATE 生效）
        q("session_update_cwd", json!({ "sessionId": "s1", "cwd": "" }));
        assert_eq!(q("session_get", json!({ "sessionId": "s1" }))["data"]["cwd"], "");
    }

    /// design_theme 偏好列往返（与 sidecar sessionPrefsSet 的 COALESCE 语义对齐）：
    /// NULL = 从未选中（恢复链回落最近使用）；JSON 串 = 选中；"" = 显式不使用主题，
    /// 且携带 "" 必须真的覆盖旧值（sidecar set_design_theme 的清除路径依赖这里）。
    #[test]
    fn session_prefs_design_theme_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(
                &db,
                &json!({ "id": "t", "kind": kind, "params": p }),
            )
        };
        q("session_insert", json!({ "sessionId": "s1", "cwd": "", "now": "t" }));

        // 从未设置：列存在且为 NULL
        assert!(q("session_get", json!({ "sessionId": "s1" }))["data"]["designTheme"].is_null());

        // 选中：JSON 串落库；未携带的其他偏好保持原值（mode 仍 NULL）
        q(
            "session_prefs_set",
            json!({ "sessionId": "s1", "designTheme": "{\"scope\":\"builtin\",\"id\":\"apple\"}" }),
        );
        let got = q("session_get", json!({ "sessionId": "s1" }))["data"].clone();
        assert_eq!(got["designTheme"], "{\"scope\":\"builtin\",\"id\":\"apple\"}");
        assert!(got["mode"].is_null());

        // 显式不使用主题："" 是携带值，必须覆盖旧值
        q("session_prefs_set", json!({ "sessionId": "s1", "designTheme": "" }));
        assert_eq!(q("session_get", json!({ "sessionId": "s1" }))["data"]["designTheme"], "");
    }

    /// app_mode 偏好列往返（会话级工作模式，与 thinking_level 同型）：
    /// NULL = 本会话从未切换过（跟随全局默认 kv pi.app_mode）；定靶写入只动本会话，
    /// 未携带的其他偏好保持原值。列表投影 session_list 也必须带上该列，
    /// 否则前端切回会话时无从水合（显示回落默认 = 看起来像"模式没记住"）。
    #[test]
    fn session_prefs_app_mode_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(
                &db,
                &json!({ "id": "t", "kind": kind, "params": p }),
            )
        };
        q("session_insert", json!({ "sessionId": "s1", "cwd": "", "now": "t" }));

        // 从未切换：列存在且为 NULL
        assert!(q("session_get", json!({ "sessionId": "s1" }))["data"]["appMode"].is_null());

        // 定靶写入：落库，且不牵连其他偏好列
        q("session_prefs_set", json!({ "sessionId": "s1", "appMode": "work" }));
        let got = q("session_get", json!({ "sessionId": "s1" }))["data"].clone();
        assert_eq!(got["appMode"], "work");
        assert!(got["mode"].is_null());
        assert!(got["thinkingLevel"].is_null());

        // 再切一档：覆盖为最新选择
        q("session_prefs_set", json!({ "sessionId": "s1", "appMode": "design" }));
        assert_eq!(
            q("session_get", json!({ "sessionId": "s1" }))["data"]["appMode"],
            "design"
        );

        // 列表投影同样携带（前端 piSessionPrefsMap 的取数路径）
        let list = q("session_list", json!({}))["data"].clone();
        assert_eq!(list.as_array().unwrap()[0]["appMode"], "design");
    }

    /// 旧库（无 archived 列）打开时自动补列，session_list 正常返回。
    #[test]
    fn legacy_sessions_table_gains_archived_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', \
             first_message TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', \
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO sessions (id, created_at, updated_at) VALUES ('old', 't', 't');",
        )
        .unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let rows = dispatch_host_query(
            &db,
            &json!({ "id": "t", "kind": "session_list", "params": {} }),
        )["data"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["archived"], 0);
    }

    /// 迭代 4：session_touch 的 added 增量累加 message_count，session_list 回读
    #[test]
    fn session_touch_increments_message_count() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);
        let q = |kind: &str, p: Value| {
            dispatch_host_query(&db, &json!({ "id": "t", "kind": kind, "params": p }))
        };
        let list_count = || -> i64 {
            q("session_list", json!({}))["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == "s1")
                .unwrap()["message_count"]
                .as_i64()
                .unwrap()
        };
        q("session_insert", json!({ "sessionId": "s1", "cwd": "", "now": "t" }));
        assert_eq!(list_count(), 0);
        q(
            "session_touch",
            json!({ "sessionId": "s1", "now": "t2", "title": "", "firstMessage": "", "added": 3 }),
        );
        assert_eq!(list_count(), 3);
        q("session_touch", json!({ "sessionId": "s1", "now": "t3", "added": 2 }));
        assert_eq!(list_count(), 5);
        // 缺省 added 不改计数（兼容旧调用点）
        q("session_touch", json!({ "sessionId": "s1", "now": "t4" }));
        assert_eq!(list_count(), 5);
    }

    /// 迭代 4：启动一次性回填按 JSONL 消息行数补 NULL 旧行（口径同旧 list_sessions
    /// 的扫描）；缺文件按 0；已回填行重跑不覆盖运行期增量。
    #[test]
    fn backfill_message_counts_from_jsonl() {
        let dir = std::env::temp_dir().join(format!(
            "pi-data-backfill-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("old-a.jsonl"),
            "{\"type\":\"header\"}\n\
             {\"type\":\"message\",\"seq\":0}\n\
             {\"type\":\"message\",\"seq\":1}\n\
             {\"type\":\"compaction\",\"seq\":2,\"summary\":\"s\",\"throughSeq\":1}\n\
             {\"type\":\"mess",
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        // 模拟旧行：message_count 为 NULL
        conn.execute_batch(
            "INSERT INTO sessions (id, created_at, updated_at) \
             VALUES ('old-a', 't', 't'), ('old-b', 't', 't');",
        )
        .unwrap();
        backfill_message_counts(&conn, &sessions).unwrap();
        let get = |id: &str| -> Option<i64> {
            conn.query_row(
                "SELECT message_count FROM sessions WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .unwrap()
        };
        assert_eq!(get("old-a"), Some(2), "只数 message 行，header/compaction/撕裂行不计");
        assert_eq!(get("old-b"), Some(0), "文件缺失按 0（列表按 >0 过滤自然隐藏）");
        conn.execute(
            "UPDATE sessions SET message_count = 9 WHERE id = 'old-a'",
            [],
        )
        .unwrap();
        backfill_message_counts(&conn, &sessions).unwrap();
        assert_eq!(get("old-a"), Some(9), "非 NULL 行不被重跑覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
