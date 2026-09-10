//! 主机工具执行：bash / read / write / edit。
//! 此前在 sidecar（Node child_process / fs）实现，现下沉到 Rust：
//! - bash 用 taskkill /T /F 杀整个进程树，解决 Windows 上孙进程残留
//!   （Node 的 child.kill() 只杀直接子进程）
//! - read/write/edit 用 std::fs，行为与原 TS 实现镜像（行号格式、截断上限、
//!   二进制检测、old_string 唯一性校验）
//! glob/grep 留在 sidecar：纯只读内存计算，且 JS 正则（lookahead 等）与
//! Rust regex 语法不兼容，迁移有行为风险。

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_TOOL_OUTPUT: usize = 16 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_MS: u64 = 120_000;

fn str_param(p: &Value, key: &str) -> Result<String, String> {
    p.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/// Windows 下隐藏控制台窗口（等价 Node spawn 的 windowsHide: true）
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// bash 可执行文件解析：与原 sidecar resolveShellCommand 一致——
/// Windows 用 Git Bash（PATH → git.exe 同目录 → 常见安装位置），退回 cmd.exe。
fn resolve_shell_command() -> (String, Vec<String>) {
    if !cfg!(windows) {
        return ("/bin/bash".into(), vec!["-c".into()]);
    }
    let path_dirs: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let mut candidates: Vec<String> = path_dirs.iter().map(|d| format!("{d}\\bash.exe")).collect();
    // git.exe 在 PATH 上时，尝试同安装目录的 bin\bash.exe（便携/自定义安装）
    let git_dir = path_dirs
        .iter()
        .find(|d| std::path::Path::new(&format!("{d}\\git.exe")).exists())
        .cloned();
    if let Some(git_dir) = git_dir {
        candidates.push(format!("{git_dir}\\..\\bin\\bash.exe"));
    }
    candidates.push("C:\\Program Files\\Git\\bin\\bash.exe".into());
    candidates.push("C:\\Program Files (x86)\\Git\\bin\\bash.exe".into());
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{local}\\Programs\\Git\\bin\\bash.exe"));
    }
    for file in candidates {
        if std::path::Path::new(&file).exists() {
            return (file, vec!["-c".into()]);
        }
    }
    ("cmd.exe".into(), vec!["/d".into(), "/s".into(), "/c".into()])
}

/// 运行 shell 命令：合并 stdout/stderr，超时杀进程树（taskkill /T /F）
fn run_bash(cwd: &str, command: &str, timeout_ms: u64) -> Result<Value, String> {
    let (file, prefix_args) = resolve_shell_command();
    let mut cmd = Command::new(&file);
    cmd.args(&prefix_args)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {file}: {e}"))?;
    let pid = child.id();

    let combined: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut reader_handles = Vec::new();
    let streams: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().ok_or("no stdout")?),
        Box::new(child.stderr.take().ok_or("no stderr")?),
    ];
    for stream in streams {
        let sink = Arc::clone(&combined);
        let killed_flag = Arc::clone(&killed);
        reader_handles.push(std::thread::spawn(move || {
            let mut reader = stream;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let overflow = match sink.lock() {
                            Ok(mut out) => {
                                let over = out.len() >= MAX_TOOL_OUTPUT;
                                if !over {
                                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                                }
                                over
                            }
                            Err(_) => true,
                        };
                        // 输出超限：与原 TS 行为一致，杀掉进程提前结束（防失控输出）
                        if overflow && !killed_flag.swap(true, std::sync::atomic::Ordering::Relaxed) {
                            let mut killer = Command::new("taskkill");
                            killer.args(["/PID", &pid.to_string(), "/T", "/F"])
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null());
                            no_window(&mut killer);
                            let _ = killer.output();
                        }
                    }
                }
            }
        }));
    }

    // 等 wait 结束或超时；超时后 taskkill /T /F 杀整棵进程树
    let timeout = Duration::from_millis(timeout_ms);
    let start = Instant::now();
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let mut killer = Command::new("taskkill");
                    killer.args(["/PID", &pid.to_string(), "/T", "/F"])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    no_window(&mut killer);
                    let _ = killer.output();
                    break None; // 超时
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break Some(-1),
        }
    };

    for handle in reader_handles {
        let _ = handle.join();
    }

    let mut out = Arc::try_unwrap(combined)
        .map(|m| m.into_inner().unwrap_or_default())
        .unwrap_or_default();
    let mut truncated = false;
    // UTF-8 字符边界截断（比 TS 的 UTF-16 截断更安全）
    if out.len() > MAX_TOOL_OUTPUT {
        let mut cut = MAX_TOOL_OUTPUT;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        truncated = true;
    }
    let status = match exit_code {
        Some(0) => String::new(),
        Some(code) => format!("\n[exit code: {code}]"),
        None => "\n[timeout]".to_string(),
    };
    let suffix = if truncated { "\n…[output truncated]" } else { "" };
    Ok(json!({
        "output": format!("{out}{status}{suffix}"),
        "truncated": truncated,
        "exitCode": exit_code,
    }))
}

fn read_text_file(cwd: &str, file_path: &str) -> Result<(Vec<u8>, String), String> {
    let full = resolve_path(cwd, file_path)?;
    let raw = std::fs::read(&full).map_err(|e| format!("failed to read {file_path}: {e}"))?;
    Ok((raw, full))
}

fn resolve_path(cwd: &str, p: &str) -> Result<String, String> {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        Ok(p.to_string())
    } else {
        Ok(std::path::Path::new(cwd).join(p).to_string_lossy().to_string())
    }
}

fn handle_read(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let (raw, _full) = read_text_file(cwd, &file_path)?;
    if raw.contains(&0u8) {
        return Err(format!("{file_path} is a binary file and cannot be read as text"));
    }
    let text = String::from_utf8_lossy(&raw);
    let all_lines: Vec<&str> = text.split('\n').collect();
    let offset = p.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let limit = p.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    let start = offset.saturating_sub(1);
    let end = (start + limit.unwrap_or(all_lines.len())).min(all_lines.len());
    let mut slice = all_lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{}\t{}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    if slice.len() > MAX_READ_BYTES {
        let mut cut = MAX_READ_BYTES;
        while cut > 0 && !slice.is_char_boundary(cut) {
            cut -= 1;
        }
        slice.truncate(cut);
        slice.push_str("\n…[truncated]");
    }
    let more = if end < all_lines.len() {
        format!("\n…[{} more lines, total {}]", all_lines.len() - end, all_lines.len())
    } else {
        String::new()
    };
    Ok(json!({ "output": format!("{slice}{more}"), "totalLines": all_lines.len() }))
}

fn handle_write(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let content = str_param(p, "content")?;
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let full = resolve_path(cwd, &file_path)?;
    if let Some(parent) = std::path::Path::new(&full).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dirs for {file_path}: {e}"))?;
    }
    std::fs::write(&full, content.as_bytes()).map_err(|e| format!("failed to write {file_path}: {e}"))?;
    Ok(json!({ "output": format!("Wrote {} bytes to {}", content.len(), file_path) }))
}

fn handle_edit(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let old_string = str_param(p, "old_string")?;
    let new_string = str_param(p, "new_string")?;
    let replace_all = p.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let (raw, full) = read_text_file(cwd, &file_path)?;
    if raw.contains(&0u8) {
        return Err(format!("{file_path} is a binary file and cannot be edited as text"));
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let occurrences = text.split(&old_string).count() - 1;
    if occurrences == 0 {
        return Err(format!("old_string not found in {file_path}"));
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_string appears {occurrences} times in {file_path}; provide more context or set replace_all=true"
        ));
    }
    let updated = if occurrences > 1 {
        text.replace(&old_string, &new_string)
    } else {
        text.replacen(&old_string, &new_string, 1)
    };
    std::fs::write(&full, updated.as_bytes()).map_err(|e| format!("failed to write {file_path}: {e}"))?;
    let count = if replace_all && occurrences > 1 { occurrences } else { 1 };
    Ok(json!({ "output": format!("Replaced {count} occurrence(s) in {file_path}") }))
}

/// 工具分发入口（host_query kind="tool"）：params = { name, cwd, params: {...} }
pub fn handle_tool(p: &Value) -> Result<Value, String> {
    let name = str_param(p, "name")?;
    let inner = p.get("params").cloned().unwrap_or(Value::Null);
    match name.as_str() {
        "bash" => {
            let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or(".").to_string();
            let command = str_param(&inner, "command")?;
            let timeout_ms = inner
                .get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_BASH_TIMEOUT_MS);
            run_bash(&cwd, &command, timeout_ms)
        }
        "read" => handle_read(&inner),
        "write" => handle_write(&inner),
        "edit" => handle_edit(&inner),
        _ => Err(format!("unknown host tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_formats_line_numbers_and_pagination() {
        let dir = std::env::temp_dir().join(format!("pi-tool-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.txt");
        std::fs::write(&file, "alpha\nbeta\ngamma\n").unwrap();
        let p = json!({ "file_path": file.to_string_lossy(), "offset": 2, "limit": 1 });
        let out = handle_read(&p).unwrap();
        assert_eq!(out["output"], "2\tbeta\n…[2 more lines, total 4]");
        assert_eq!(out["totalLines"], 4);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn read_rejects_binary() {
        let dir = std::env::temp_dir().join(format!("pi-tool-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("b.bin");
        std::fs::write(&file, [0x61, 0x00, 0x62]).unwrap();
        let p = json!({ "file_path": file.to_string_lossy() });
        assert!(handle_read(&p).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn write_creates_parents_and_reports_bytes() {
        let dir = std::env::temp_dir().join(format!("pi-tool-write-{}", std::process::id()));
        let file = dir.join("a/b/c.txt");
        let p = json!({ "file_path": file.to_string_lossy(), "content": "hello" });
        let out = handle_write(&p).unwrap();
        assert_eq!(out["output"], json!(format!("Wrote 5 bytes to {}", file.to_string_lossy())));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bash_runs_and_captures_output() {
        // Windows 下 Git Bash/cmd 都能跑 echo（bash.exe 缺失时回退 cmd.exe）
        let out = run_bash(".", "echo pi-smoke-bash-ok", 10_000).unwrap();
        assert_eq!(out["exitCode"], 0);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("pi-smoke-bash-ok"), "output: {text}");
        assert!(!text.contains("exit code"), "output: {text}");
    }

    #[test]
    fn bash_timeout_kills_and_reports() {
        // 耗时 >1s 的命令：Windows 用 ping -n 3（Git Bash/cmd 都可用），
        // Unix 用 sleep 2（ping -n 在 BSD/macOS 是不同语义，会立即报错）
        let cmd = if cfg!(windows) { "ping -n 3 127.0.0.1" } else { "sleep 2" };
        let out = run_bash(".", cmd, 300).unwrap();
        assert_eq!(out["exitCode"], Value::Null);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[timeout]"), "output: {text}");
    }

    #[test]
    fn edit_checks_occurrences() {
        let dir = std::env::temp_dir().join(format!("pi-tool-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("e.txt");
        std::fs::write(&file, "x\ny\nx\n").unwrap();
        let path_str = file.to_string_lossy().to_string();
        // 多处出现且未 replace_all → 报错
        let p = json!({ "file_path": path_str, "old_string": "x", "new_string": "z" });
        assert!(handle_edit(&p).is_err());
        // replace_all
        let p2 = json!({ "file_path": path_str, "old_string": "x", "new_string": "z", "replace_all": true });
        let out = handle_edit(&p2).unwrap();
        assert_eq!(out["output"], json!(format!("Replaced 2 occurrence(s) in {path_str}")));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "z\ny\nz\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
