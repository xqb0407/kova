//! 密钥的**执行时**解析、注入与输出脱敏（设计：docs/secrets-env-design.md）。
//!
//! 分工：`data.rs` 负责密文的存取（secret_list/set/delete，无明文出口）；
//! 本模块负责在工具执行路径上把**名字**解成明文，用完即弃：
//!
//! 1. `resolve_into_envelope`：工具调用前，短暂持 db 锁按名字查表 + `secret::decrypt`，
//!    结果写进信封的 `secretEnvResolved`。名字由 sidecar 送（`secretEnv`），
//!    明文只在 Rust 进程内存活一次工具调用的时长，**不跨 RPC 边界**。
//! 2. `apply_env`：把明文注入派生出的子进程环境（只影响这一次调用）。
//! 3. `redact`：子进程输出回程前，用当次明文替换（原值 + base64 变体），
//!    因为输出一旦回到 sidecar 就会顺着 tool_execution_end 进转录落盘。
//!
//! 脱敏是**兜底而非防线**：它挡不住任意编码变形（hex、分片拼接、
//! 脚本自行编码）。真正的防线是注入策略——用户没绑定的密钥根本不会被解析。

use std::process::Command;
use std::sync::Mutex;

use base64::Engine as _;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::data::is_valid_secret_name;

/// 短值护栏：低于此长度的明文不参与脱敏。密钥短到这种程度时，
/// 全文替换会误伤正常输出（如值为 "1" 会把所有 "1" 抹掉），
/// 收益（挡住一个 4 字符密钥）远小于代价（输出不可读）。
const REDACT_MIN_LEN: usize = 8;

/// 单次调用允许注入的密钥数上限：正常绑定远小于此，防失控列表。
const MAX_RESOLVED: usize = 32;

/// 从信封取 sidecar 送来的名字清单：`params.secretEnv = [{ name, scope }]`。
/// 形状非法/超上限的条目一律丢弃（不报错——注入失败不该让工具调用失败）。
fn parse_requests(envelope: &Value) -> Vec<(String, String)> {
    let Some(list) = envelope.get("secretEnv").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in list.iter().take(MAX_RESOLVED) {
        let Some(name) = item.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_valid_secret_name(name) {
            continue;
        }
        let scope = item
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("global");
        out.push((name.to_string(), scope.to_string()));
    }
    out
}

/// 名字 → 明文。作用域优先级：请求的 scope 命中即用，否则回落 `global`
/// （工作区行覆盖同名全局行，与技能/子代理/MCP 的"更具体者优先"同款语义）。
/// 查不到 / 解不开（换机、主密钥丢失）的条目**静默跳过**：注入是尽力而为，
/// 缺一个密钥不该让整条命令失败——命令自己会因为空变量报错，那更可诊断。
fn resolve_names(conn: &Connection, requests: &[(String, String)]) -> Vec<(String, String)> {
    if requests.is_empty() {
        return Vec::new();
    }
    let mut stmt = match conn.prepare("SELECT value FROM secrets WHERE name = ?1 AND scope = ?2") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[secret_env] prepare failed: {e}");
            return Vec::new();
        }
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, scope) in requests {
        // 候选作用域：请求值优先，global 兜底（两者相同时只试一次）
        let mut candidates: Vec<&str> = vec![scope.as_str()];
        if scope != "global" {
            candidates.push("global");
        }
        for candidate in candidates {
            let stored: Option<String> = stmt
                .query_row(params![name, candidate], |row| row.get::<_, String>(0))
                .ok();
            let Some(stored) = stored else { continue };
            match crate::secret::decrypt(&stored) {
                Ok(plain) => {
                    out.push((name.clone(), plain));
                    break;
                }
                Err(e) => {
                    log::warn!("[secret_env] decrypt failed for {name} ({candidate}): {e}");
                    break;
                }
            }
        }
    }
    out
}

/// 工具调用前解析（`dispatch_host_query` 的 tool 分支调用）。
/// 只在确实带了 `secretEnv` 时才取 db 锁——常见路径（无密钥注入）零开销、
/// 行为与从前完全一致；解析完立即解锁，长 bash 不占 db 锁。
/// 任何失败只记日志：注入不了就当作没绑定，工具照常执行。
pub fn resolve_into_envelope(db: &Mutex<Connection>, envelope: &mut Value) {
    let requests = parse_requests(envelope);
    if requests.is_empty() {
        return;
    }
    let resolved = match db.lock() {
        Ok(conn) => resolve_names(&conn, &requests),
        Err(e) => {
            log::warn!("[secret_env] db poisoned, skipping injection: {e}");
            return;
        }
    };
    if resolved.is_empty() {
        // 绑定了名字但库里没有（或解不开）：留一条名字级日志便于诊断，
        // 永不打印值
        log::warn!(
            "[secret_env] no injectable secret for {:?}",
            requests.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>()
        );
        return;
    }
    log::info!(
        "[secret_env] injecting {} secret(s): {:?}",
        resolved.len(),
        resolved.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>()
    );
    if let Some(map) = envelope.as_object_mut() {
        map.insert(
            "secretEnvResolved".to_string(),
            Value::Array(
                resolved
                    .iter()
                    .map(|(name, value)| json!({ "name": name, "value": value }))
                    .collect(),
            ),
        );
    }
}

/// 读回 `resolve_into_envelope` 写下的明文对（只有工具执行函数该调它）
pub fn take_resolved(envelope: &Value) -> Vec<(String, String)> {
    let Some(list) = envelope.get("secretEnvResolved").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .take(MAX_RESOLVED)
        .filter_map(|item| {
            let name = item.get("name").and_then(|v| v.as_str())?;
            let value = item.get("value").and_then(|v| v.as_str())?;
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// 把明文注入派生进程的环境（只影响这一次调用；父进程环境照常继承，
/// 否则会切断 PATH/HOME 等基本变量）
pub fn apply_env(cmd: &mut Command, resolved: &[(String, String)]) {
    for (name, value) in resolved {
        cmd.env(name, value);
    }
}

/// 输出脱敏：把当次注入的明文替换成 `[REDACTED:<NAME>]`。
/// 覆盖原值与 base64 变体（密钥常被塞进 Authorization/JSON 载荷里传输）。
/// 长短值护栏见 REDACT_MIN_LEN。
pub fn redact(text: &str, resolved: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (name, value) in resolved {
        if value.chars().count() < REDACT_MIN_LEN {
            continue;
        }
        let marker = format!("[REDACTED:{name}]");
        out = out.replace(value.as_str(), &marker);
        let b64 = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        if b64 != *value {
            out = out.replace(&b64, &marker);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::MAX_SECRET_VALUE_BYTES;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::data::init_tables(&conn).unwrap();
        conn
    }

    fn put(conn: &Connection, name: &str, scope: &str, value: &str) {
        conn.execute(
            "INSERT INTO secrets (name, scope, value, updated_at) VALUES (?1, ?2, ?3, 'now')",
            params![name, scope, crate::secret::encrypt(value)],
        )
        .unwrap();
    }

    #[test]
    fn resolve_prefers_requested_scope_then_global() {
        let conn = mem_db();
        put(&conn, "TOKEN", "global", "global-value-1234");
        put(&conn, "TOKEN", "workspace:/repo", "workspace-value-5678");
        // 工作区绑定命中工作区行
        let got = resolve_names(&conn, &[("TOKEN".into(), "workspace:/repo".into())]);
        assert_eq!(got, vec![("TOKEN".to_string(), "workspace-value-5678".to_string())]);
        // 另一个工作区回落全局行（全局密钥也能满足工作区绑定）
        let got = resolve_names(&conn, &[("TOKEN".into(), "workspace:/other".into())]);
        assert_eq!(got, vec![("TOKEN".to_string(), "global-value-1234".to_string())]);
        // 全局绑定只取全局行
        let got = resolve_names(&conn, &[("TOKEN".into(), "global".into())]);
        assert_eq!(got, vec![("TOKEN".to_string(), "global-value-1234".to_string())]);
    }

    #[test]
    fn resolve_skips_missing_and_corrupt() {
        let conn = mem_db();
        put(&conn, "GOOD", "global", "good-value-1234");
        // 有前缀但内容坏（截断密文 / 密钥不匹配）：解不开 → 跳过，不影响其他条目
        conn.execute(
            "INSERT INTO secrets (name, scope, value, updated_at) VALUES ('CORRUPT', 'global', 'enc:v1:bm90LXZhbGlkLWJhc2U2NA==', 'now')",
            [],
        )
        .unwrap();
        let got = resolve_names(
            &conn,
            &[
                ("MISSING".into(), "global".into()),
                ("GOOD".into(), "global".into()),
                ("CORRUPT".into(), "global".into()),
            ],
        );
        assert_eq!(got, vec![("GOOD".to_string(), "good-value-1234".to_string())]);
    }

    /// 明文值原样注入（当前 secret::decrypt 即直通，见该模块「当前不加密」的说明）。
    /// 残留的 `enc:v1:` 历史密文由 decrypt 判为缺失，不会被当明文注入。
    #[test]
    fn resolve_passes_through_legacy_plaintext() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO secrets (name, scope, value, updated_at) VALUES ('LEGACY', 'global', 'plaintext-legacy-1234', 'now')",
            [],
        )
        .unwrap();
        let got = resolve_names(&conn, &[("LEGACY".into(), "global".into())]);
        assert_eq!(got, vec![("LEGACY".to_string(), "plaintext-legacy-1234".to_string())]);
    }

    #[test]
    fn parse_requests_rejects_malformed() {
        let env = json!({
            "secretEnv": [
                { "name": "OK_ONE", "scope": "global" },
                { "name": "bad name" },
                { "name": "1LEADING_DIGIT" },
                { "scope": "global" },
                "not-an-object"
            ]
        });
        assert_eq!(parse_requests(&env), vec![("OK_ONE".to_string(), "global".to_string())]);
        // 缺 scope 默认 global
        let env = json!({ "secretEnv": [{ "name": "NO_SCOPE" }] });
        assert_eq!(parse_requests(&env), vec![("NO_SCOPE".to_string(), "global".to_string())]);
        // 无字段 = 无请求
        assert!(parse_requests(&json!({})).is_empty());
        assert!(parse_requests(&json!({ "secretEnv": "nope" })).is_empty());
    }

    #[test]
    fn redact_replaces_value_and_base64_variant() {
        let resolved = vec![("TOKEN".to_string(), "s3cr3t-value-9x".to_string())];
        let b64 = base64::engine::general_purpose::STANDARD.encode("s3cr3t-value-9x");
        let text = format!("plain=s3cr3t-value-9x b64={b64} other=keep");
        let out = redact(&text, &resolved);
        assert!(!out.contains("s3cr3t-value-9x"));
        assert!(!out.contains(&b64));
        assert_eq!(out.matches("[REDACTED:TOKEN]").count(), 2);
        assert!(out.contains("other=keep"));
    }

    #[test]
    fn redact_skips_short_values() {
        // 短值不脱敏：否则会把输出里所有 "ab" 抹掉
        let resolved = vec![("PIN".to_string(), "ab".to_string())];
        assert_eq!(redact("abab grab", &resolved), "abab grab");
    }

    #[test]
    fn apply_env_injects_into_child_process() {
        let resolved = vec![("DEMO_TOKEN".to_string(), "injected-value-1234".to_string())];
        let (shell, args) = if cfg!(windows) {
            ("cmd.exe".to_string(), vec!["/c".to_string(), "echo %DEMO_TOKEN%".to_string()])
        } else {
            ("/bin/sh".to_string(), vec!["-c".to_string(), "printf %s \"$DEMO_TOKEN\"".to_string()])
        };
        let mut cmd = Command::new(&shell);
        cmd.args(&args);
        apply_env(&mut cmd, &resolved);
        let out = cmd.output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("injected-value-1234"), "got: {stdout}");
    }

    #[test]
    fn secret_list_never_returns_plaintext() {
        let conn = mem_db();
        put(&conn, "SOME_TOKEN", "global", "plain-value-abcd");
        let listed = crate::data::handle_host_query(&conn, "secret_list", &json!({})).unwrap();
        let text = listed.to_string();
        assert!(!text.contains("plain-value-abcd"), "plaintext leaked: {text}");
        assert_eq!(listed[0]["masked"], "****abcd");
        assert_eq!(listed[0]["readable"], true);
    }

    #[test]
    fn secret_get_does_not_exist() {
        // 协议面结构性保证：没有明文出口
        let conn = mem_db();
        assert!(crate::data::handle_host_query(&conn, "secret_get", &json!({})).is_err());
    }

    #[test]
    fn secret_set_validates_name_scope_and_size() {
        let conn = mem_db();
        let err = crate::data::handle_host_query(
            &conn,
            "secret_set",
            &json!({ "name": "1BAD", "scope": "global", "value": "x", "now": "t" }),
        );
        assert!(err.is_err());
        let err = crate::data::handle_host_query(
            &conn,
            "secret_set",
            &json!({ "name": "OK", "scope": "elsewhere", "value": "x", "now": "t" }),
        );
        assert!(err.is_err());
        let err = crate::data::handle_host_query(
            &conn,
            "secret_set",
            &json!({ "name": "OK", "scope": "global", "value": "", "now": "t" }),
        );
        assert!(err.is_err());
        let big = "x".repeat(MAX_SECRET_VALUE_BYTES + 1);
        let err = crate::data::handle_host_query(
            &conn,
            "secret_set",
            &json!({ "name": "OK", "scope": "global", "value": big, "now": "t" }),
        );
        assert!(err.is_err());
        // 合法写入 + 删除
        crate::data::handle_host_query(
            &conn,
            "secret_set",
            &json!({ "name": "OK", "scope": "global", "value": "fine-value", "now": "t" }),
        )
        .unwrap();
        crate::data::handle_host_query(
            &conn,
            "secret_delete",
            &json!({ "name": "OK", "scope": "global" }),
        )
        .unwrap();
        let listed = crate::data::handle_host_query(&conn, "secret_list", &json!({})).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 0);
    }
}
