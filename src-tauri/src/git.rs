//! Git 集成（设计见 .zcode/plans/plan-git-integration.md）。
//! CLI 包装：std::process::Command 直调系统 git（不用 git2，复用 tool_exec 的
//! no_window 等进程基建），解析统一走 `--porcelain=v2 -z` / `--name-status -z`
//! 机器格式。检查点用影子 git-dir（`<app_data>/checkpoints/<fnv1a(cwd)>/`），
//! 不碰用户仓库的 refs/index/stash。
//!
//! 安全约束：
//! - 全部命令固定前缀 `-C <cwd> --no-optional-locks`，参数以数组传递，绝不拼接 shell；
//! - cwd 必须与 workspace-store（kv "workspace"）canonicalize 后一致，不接受任意路径；
//! - diff 输出体积上限截断 + truncated 标记；写命令按 cwd 串行化。

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::tool_exec::no_window;

/// 单文件 patch 上限（字符）
const MAX_DIFF_FILE_BYTES: usize = 256 * 1024;
/// 一次 diff 调用的 patch 总量上限，超出后停止取后续文件的 patch
const MAX_DIFF_TOTAL_BYTES: usize = 1024 * 1024;
/// 一次 diff 最多展开的文件数
const MAX_DIFF_FILES: usize = 200;
/// git_show 内容上限
const MAX_SHOW_BYTES: usize = 1024 * 1024;
/// 检查点 ref 前缀（影子仓库内），LRU 保留个数
const CHECKPOINT_REF_PREFIX: &str = "refs/xulux";
const CHECKPOINT_KEEP: usize = 20;
/// 影子仓库的 info/exclude 兜底规则：即便用户删了 .gitignore，
/// 也不把依赖目录快照/还原（否则 apply -R 会删真实安装的 node_modules）
const SHADOW_EXCLUDES: &str = "node_modules/\n.next/\nnuxt/\ndist/\nbuild/\nout/\ntarget/\n__pycache__/\nvendor/\n";
/// info/exclude 里我们那段规则的幂等标记（marker 行本身不是 pattern）
const SHADOW_EXCLUDE_MARKER: &str = "# xulux-checkpoint-excludes";
/// 运行结束时的全量反向 patch 落盘目录/体积上限（restore 优先用它做冲突中止）
const MAX_PATCH_FILE_BYTES: usize = 32 * 1024 * 1024;

/* ------------------------------ 进程执行 ------------------------------ */

struct GitOut {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

fn git_run(
    args: &[String],
    stdin: Option<&[u8]>,
    envs: &[(&str, &str)],
) -> Result<GitOut, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if let Some(buf) = stdin {
        // apply 类命令先读完整 stdin 才产出；stdout/stderr 由 wait_with_output
        // 并行抽干，pipe 写阻塞与读阻塞不会互锁
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(buf);
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait git: {e}"))?;
    Ok(GitOut {
        ok: out.status.success(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

fn ga(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/// 用户仓库命令：固定注入 `-C cwd --no-optional-locks`
fn user_git(cwd: &str, rest: &[impl AsRef<str>]) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "-C".into(),
        cwd.into(),
        "--no-optional-locks".into(),
    ];
    v.extend(rest.iter().map(|s| s.as_ref().to_string()));
    v
}

/// 影子仓库命令：git-dir + work-tree 分离
fn shadow_git(dir: &str, work: &str, rest: &[impl AsRef<str>]) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "--git-dir".into(),
        dir.into(),
        "--work-tree".into(),
        work.into(),
        "--no-optional-locks".into(),
    ];
    v.extend(rest.iter().map(|s| s.as_ref().to_string()));
    v
}

/* ------------------------------ 探测与校验 ------------------------------ */

static GIT_VERSION: OnceLock<Option<String>> = OnceLock::new();

fn git_version() -> Option<&'static str> {
    GIT_VERSION
        .get_or_init(|| {
            git_run(&ga(&["--version"]), None, &[])
                .ok()
                .filter(|o| o.ok)
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .as_deref()
}

fn ensure_git() -> Result<(), String> {
    if git_version().is_some() {
        Ok(())
    } else {
        Err("no-git".into())
    }
}

fn ensure_repo(cwd: &str) -> Result<(), String> {
    let o = git_run(
        &user_git(cwd, &["rev-parse", "--is-inside-work-tree"]),
        None,
        &[],
    )?;
    if o.ok && String::from_utf8_lossy(&o.stdout).trim() == "true" {
        Ok(())
    } else {
        Err("not-repo".into())
    }
}

/// cwd 必须是前端 workspace-store 里那个目录（canonicalize 后比对），
/// 防止面板被注入任意路径执行 git。
/// run = 原始 cwd（git -C 用，避免 Windows canonicalize 的 \\?\ 前缀）；
/// key = canonical 路径（写锁与影子仓库目录名的稳定标识）。
struct Resolved {
    run: String,
    key: String,
}

fn resolve_workspace(app: &AppHandle, cwd: &str) -> Result<Resolved, String> {
    ensure_git()?;
    let stored = crate::store::kv_get_global(app, "workspace")
        .map_err(|_| "cwd-not-allowed")?
        .filter(|s| !s.is_empty());
    let want = stored.ok_or("cwd-not-allowed")?;
    let a = std::fs::canonicalize(cwd).map_err(|_| "cwd-not-allowed")?;
    let b = std::fs::canonicalize(&want).map_err(|_| "cwd-not-allowed")?;
    if a != b {
        return Err("cwd-not-allowed".into());
    }
    Ok(Resolved {
        run: cwd.to_string(),
        key: a.to_string_lossy().into_owned(),
    })
}

/* ------------------------------ 写命令串行化 ------------------------------ */

fn cwd_locks() -> &'static StdMutex<HashMap<String, Arc<StdMutex<()>>>> {
    static MAP: OnceLock<StdMutex<HashMap<String, Arc<StdMutex<()>>>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

fn with_cwd_lock<T>(key: &str, f: impl FnOnce() -> T) -> T {
    let m = {
        let mut map = cwd_locks().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(StdMutex::new(())))
            .clone()
    };
    let _g = m.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn emit_changed(app: &AppHandle, cwd: &str) {
    let _ = app.emit("git-changed", json!({ "cwd": cwd }));
}

/* ------------------------------ porcelain v2 解析 ------------------------------ */

#[derive(Debug, Clone, PartialEq)]
pub struct StatusFile {
    pub path: String,
    pub old_path: Option<String>,
    /// 'A' | 'M' | 'D' | 'R' | '?' | 'U'
    pub kind: char,
    /// 索引侧（X 位）有变更 = 已暂存
    pub staged: bool,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedStatus {
    pub oid: String,
    pub head: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<StatusFile>,
}

fn classify(path: String, old_path: Option<String>, xy: &str) -> StatusFile {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let untracked = xy == "??";
    let staged = !untracked && !matches!(x, '.' | ' ');
    let kind = if untracked {
        '?'
    } else if matches!(x, 'D') || matches!(y, 'D') {
        'D'
    } else if matches!(x, 'R') || matches!(y, 'R') || matches!(x, 'C') || matches!(y, 'C') {
        'R'
    } else if matches!(x, 'A') {
        'A'
    } else {
        'M'
    };
    StatusFile {
        path,
        old_path,
        kind,
        staged,
    }
}

/// 解析 `git status --porcelain=v2 --branch -z` 输出。
/// NUL 分隔记录；type 1 固定 7 字段+路径（splitn 8），type 2 固定 8 字段+路径
/// 且路径后**另起一条记录**携带原路径（实测 git 2.50）。
pub fn parse_status_v2(raw: &[u8]) -> ParsedStatus {
    let text = String::from_utf8_lossy(raw).to_string();
    let recs: Vec<&str> = text.split('\0').collect();
    let mut out = ParsedStatus::default();
    let mut i = 0usize;
    while i < recs.len() {
        let rec = recs[i];
        i += 1;
        if rec.is_empty() {
            continue;
        }
        if let Some(v) = rec.strip_prefix("# branch.oid ") {
            out.oid = v.to_string();
        } else if let Some(v) = rec.strip_prefix("# branch.head ") {
            out.head = v.to_string();
        } else if let Some(v) = rec.strip_prefix("# branch.upstream ") {
            out.upstream = Some(v.to_string());
        } else if let Some(v) = rec.strip_prefix("# branch.ab ") {
            let mut it = v.split(' ');
            out.ahead = it
                .next()
                .and_then(|s| s.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            out.behind = it
                .next()
                .and_then(|s| s.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        } else if let Some(rest) = rec.strip_prefix("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let mut it = rest.splitn(8, ' ');
            let (Some(xy), Some(_), Some(_), Some(_), Some(_), Some(_), Some(_), Some(path)) = (
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
            ) else {
                continue;
            };
            out.files.push(classify(path.to_string(), None, xy));
        } else if let Some(rest) = rec.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>，下一条记录 = 原路径
            let mut it = rest.splitn(9, ' ');
            let (Some(xy), Some(_), Some(_), Some(_), Some(_), Some(_), Some(_), Some(_), Some(path)) = (
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
            ) else {
                continue;
            };
            let old = if i < recs.len() {
                let v = recs[i].to_string();
                i += 1;
                Some(v)
            } else {
                None
            };
            out.files.push(classify(path.to_string(), old, xy));
        } else if let Some(rest) = rec.strip_prefix("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let mut it = rest.splitn(11, ' ');
            let xy = it.next();
            for _ in 0..9 {
                it.next();
            }
            let path = it.next();
            match (xy, path) {
                (Some(xy), Some(path)) => {
                    out.files.push(classify(path.to_string(), None, xy));
                }
                _ => {}
            }
        } else if let Some(path) = rec.strip_prefix("? ") {
            out.files.push(classify(path.to_string(), None, "??"));
        }
        // "! "（ignored）记录直接跳过
    }
    out
}

fn status_file_json(f: &StatusFile) -> Value {
    json!({
        "path": f.path,
        "oldPath": f.old_path,
        "status": f.kind.to_string(),
        "staged": f.staged,
    })
}

fn last_commit_json(cwd: &str) -> Value {
    let o = match git_run(
        &user_git(
            cwd,
            &["log", "-1", "--pretty=format:%H%x1f%h%x1f%ct%x1f%s"],
        ),
        None,
        &[],
    ) {
        Ok(o) if o.ok => o,
        _ => return Value::Null, // unborn HEAD 等：无最近提交
    };
    let line = String::from_utf8_lossy(&o.stdout).to_string();
    let mut it = line.split('\u{1f}');
    let (Some(hash), Some(short), Some(ct), Some(subject)) =
        (it.next(), it.next(), it.next(), it.next())
    else {
        return Value::Null;
    };
    json!({
        "hash": hash,
        "short": short,
        "time": ct.parse::<i64>().unwrap_or(0) * 1000,
        "subject": subject,
    })
}

fn status_impl(cwd: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let o = git_run(
        &user_git(
            cwd,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
                "-z",
            ],
        ),
        None,
        &[],
    )?;
    if !o.ok {
        return Err(format!("git-status-failed: {}", o.stderr));
    }
    let p = parse_status_v2(&o.stdout);
    let detached = p.head.starts_with("(detached");
    let unborn = p.head.starts_with("(unborn");
    let branch = if detached {
        p.oid.chars().take(7).collect::<String>()
    } else if unborn {
        String::new()
    } else {
        p.head.clone()
    };
    Ok(json!({
        "branch": branch,
        "detached": detached,
        "unborn": unborn,
        "upstream": p.upstream,
        "ahead": p.ahead,
        "behind": p.behind,
        "files": p.files.iter().map(status_file_json).collect::<Vec<_>>(),
        "dirty": p.files.len(),
        "lastCommit": last_commit_json(cwd),
    }))
}

/* ------------------------------ diff ------------------------------ */

/// 从 unified diff 文本统计 ±行数与二进制标记（hunk 外头部不计）。
pub fn patch_stats(patch: &str) -> (u32, u32, bool) {
    let (mut added, mut removed) = (0u32, 0u32);
    let mut binary = false;
    let mut in_hunk = false;
    for line in patch.lines() {
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            binary = true;
            continue;
        }
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("new file")
            || line.starts_with("deleted file")
            || line.starts_with("similarity ")
            || line.starts_with("rename ")
            || line.starts_with("copy ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            in_hunk = false;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed, binary)
}

fn cap_patch_chars(mut s: String) -> (String, bool) {
    if s.len() <= MAX_DIFF_FILE_BYTES {
        return (s, false);
    }
    let mut cut = MAX_DIFF_FILE_BYTES;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    (s, true)
}

/// 未跟踪文件：直接读盘合成"全新增" patch（跨平台，免 --no-index 的 /dev/null 差异）。
fn untracked_diff_entry(cwd: &str, path: &str, staged: bool) -> Value {
    let abs = Path::new(cwd).join(path);
    let raw = std::fs::read(&abs).unwrap_or_default();
    if raw.contains(&0u8) {
        return json!({
            "path": path, "status": "?", "staged": staged,
            "added": 0, "removed": 0, "binary": true, "patch": "",
        });
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let (text, capped) = cap_patch_chars(text);
    let all: Vec<&str> = text.split('\n').collect();
    // 末尾换行 split 出的空尾行不算内容行
    let lines = if all.last().copied() == Some("") {
        &all[..all.len() - 1]
    } else {
        &all[..]
    };
    let mut patch = String::new();
    patch.push_str("--- /dev/null\n");
    patch.push_str(&format!("+++ b/{path}\n"));
    patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for l in lines {
        patch.push('+');
        patch.push_str(l);
        patch.push('\n');
    }
    json!({
        "path": path, "status": "?", "staged": staged,
        "added": lines.len() as u32, "removed": 0, "binary": false,
        "patch": patch, "truncated": capped,
    })
}

fn diff_file_json(f: &StatusFile, patch: String, added: u32, removed: u32, binary: bool) -> Value {
    json!({
        "path": f.path,
        "oldPath": f.old_path,
        "status": f.kind.to_string(),
        "staged": f.staged,
        "added": added,
        "removed": removed,
        "binary": binary,
        "patch": patch,
    })
}

/// 工作区（含未跟踪）vs HEAD 的真实 diff：含 agent 用 bash 改的文件。
fn diff_head_impl(cwd: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let o = git_run(
        &user_git(cwd, &["status", "--porcelain=v2", "--untracked-files=all", "-z"]),
        None,
        &[],
    )?;
    if !o.ok {
        return Err(format!("git-status-failed: {}", o.stderr));
    }
    let p = parse_status_v2(&o.stdout);
    let mut files: Vec<Value> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    for f in &p.files {
        if files.len() >= MAX_DIFF_FILES {
            truncated = true;
            files.push(diff_file_json(f, String::new(), 0, 0, false));
            continue;
        }
        if total > MAX_DIFF_TOTAL_BYTES {
            // 总量超限：后续文件不再取 patch（列表与状态仍在）
            truncated = true;
            files.push(diff_file_json(f, String::new(), 0, 0, false));
            continue;
        }
        if f.kind == '?' {
            let e = untracked_diff_entry(cwd, &f.path, f.staged);
            total += e["patch"].as_str().map(|s| s.len()).unwrap_or(0);
            files.push(e);
            continue;
        }
        // 重命名需同时给出新/旧两个字面 pathspec，否则单侧只显示成新文件
        let mut rest: Vec<String> = vec![
            "diff".into(),
            "HEAD".into(),
            "--no-color".into(),
            "--unified=3".into(),
            "--no-ext-diff".into(),
            "--".into(),
            format!(":(literal){}", f.path),
        ];
        if let Some(old) = &f.old_path {
            rest.push(format!(":(literal){old}"));
        }
        let d = git_run(&user_git(cwd, &rest), None, &[]).unwrap_or(GitOut {
            ok: false,
            stdout: Vec::new(),
            stderr: String::new(),
        });
        if !d.ok {
            files.push(diff_file_json(f, String::new(), 0, 0, false));
            continue;
        }
        let (patch, capped) = cap_patch_chars(String::from_utf8_lossy(&d.stdout).to_string());
        let (added, removed, binary) = patch_stats(&patch);
        total += patch.len();
        truncated |= capped;
        files.push(diff_file_json(f, patch, added, removed, binary));
    }
    Ok(json!({ "files": files, "truncated": truncated }))
}

/* ------------------------------ show / log ------------------------------ */

/// 校验版本引用：只允许 HEAD / 十六进制 hash / 常规分支名（防参数注入）
fn check_reference(r: &str) -> Result<(), String> {
    let ok = !r.is_empty()
        && r.len() <= 100
        && !r.starts_with('-')
        && r
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "..^~_/@-".contains(c));
    if ok {
        Ok(())
    } else {
        Err("bad-reference".into())
    }
}

fn check_hash(h: &str) -> Result<(), String> {
    let ok = h.len() >= 7 && h.len() <= 64 && h.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err("bad-hash".into())
    }
}

fn show_impl(cwd: &str, reference: &str, path: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    check_reference(reference)?;
    let o = git_run(
        &user_git(cwd, &["show", &format!("{reference}:{path}")]),
        None,
        &[],
    )?;
    if !o.ok {
        return Err(format!("git-show-failed: {}", o.stderr));
    }
    let binary = o.stdout.contains(&0u8);
    let (content, truncated) = if binary {
        (String::new(), false)
    } else {
        let s = String::from_utf8_lossy(&o.stdout).to_string();
        if s.len() > MAX_SHOW_BYTES {
            let mut cut = MAX_SHOW_BYTES;
            while cut > 0 && !s.is_char_boundary(cut) {
                cut -= 1;
            }
            (s[..cut].to_string(), true)
        } else {
            (s, false)
        }
    };
    Ok(json!({ "content": content, "truncated": truncated, "binary": binary }))
}

/// 读工作区文件内容（diff 分隔条点击展开时给 @pierre/diffs 补水用）。
/// path 为仓库根相对路径（patch 头 a/ b/ 前缀已由前端剥除），拒绝绝对路径
/// 与父目录跳转；二进制/体积上限策略与 git_show 一致。
fn worktree_read_impl(cwd: &str, path: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let rel = Path::new(path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("bad-path".into());
    }
    let t = git_run(
        &user_git(cwd, &["rev-parse", "--show-toplevel"]),
        None,
        &[],
    )?;
    if !t.ok {
        return Err("not-repo".into());
    }
    let root = String::from_utf8_lossy(&t.stdout).trim_end().to_string();
    let bytes = std::fs::read(Path::new(&root).join(rel)).map_err(|_| "read-failed".to_string())?;
    let binary = bytes.contains(&0u8);
    let (content, truncated) = if binary {
        (String::new(), false)
    } else {
        let s = String::from_utf8_lossy(&bytes).to_string();
        if s.len() > MAX_SHOW_BYTES {
            let mut cut = MAX_SHOW_BYTES;
            while cut > 0 && !s.is_char_boundary(cut) {
                cut -= 1;
            }
            (s[..cut].to_string(), true)
        } else {
            (s, false)
        }
    };
    Ok(json!({ "content": content, "truncated": truncated, "binary": binary }))
}

fn log_impl(cwd: &str, limit: u32) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let limit = limit.clamp(1, 200).to_string();
    let o = git_run(
        &user_git(
            cwd,
            &[
                "log",
                "-n",
                &limit,
                "--no-color",
                "--pretty=format:%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1e",
            ],
        ),
        None,
        &[],
    );
    // unborn HEAD：还没有提交，空历史而非报错
    let o = match o {
        Ok(o) => o,
        Err(e) => return Err(e),
    };
    if !o.ok {
        return Ok(json!([]));
    }
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let entries: Vec<Value> = text
        .split('\u{1e}')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let mut it = rec.split('\u{1f}');
            let (Some(hash), Some(short), Some(ct), Some(author), Some(subject)) =
                (it.next(), it.next(), it.next(), it.next(), it.next())
            else {
                return None;
            };
            Some(json!({
                "hash": hash,
                "short": short,
                "time": ct.parse::<i64>().unwrap_or(0) * 1000,
                "author": author,
                "subject": subject,
            }))
        })
        .collect();
    Ok(Value::Array(entries))
}

/* ------------------------------ 提交图谱 ------------------------------ */

/// 解析 `--decorate=full` 的 %D 字段："HEAD -> refs/heads/main, refs/remotes/origin/x, tag: refs/tags/v1"
/// → [{name, kind}]，kind ∈ head|branch|remote|tag。分支短名可能含 '/'（feature/x），
/// 所以必须用 full 形式按 refs/ 前缀区分，不能靠启发式。
/// 注：%D 不带外层括号（那是 %d 的形式），这里两种都容错。
fn parse_refs(decor: &str) -> Vec<Value> {
    let raw = decor.trim();
    let inner = raw
        .strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(raw);
    if inner.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for part in inner.split(", ") {
        let part = part.trim();
        let (name, kind) = if let Some(t) = part.strip_prefix("tag: ") {
            (t.strip_prefix("refs/tags/").unwrap_or(t), "tag")
        } else if let Some(t) = part.strip_prefix("HEAD -> ") {
            out.push(json!({ "name": "HEAD", "kind": "head" }));
            (t.strip_prefix("refs/heads/").unwrap_or(t), "branch")
        } else if part == "HEAD" || part.starts_with("HEAD ") {
            ("HEAD", "head")
        } else if let Some(t) = part.strip_prefix("refs/heads/") {
            (t, "branch")
        } else if let Some(t) = part.strip_prefix("refs/remotes/") {
            (t, "remote")
        } else if let Some(t) = part.strip_prefix("refs/tags/") {
            (t, "tag")
        } else {
            continue;
        };
        out.push(json!({ "name": name, "kind": kind }));
    }
    out
}

/// 拓扑序提交图（含所有本地/远端分支）：parents 供前端算车道，refs 供标签渲染
fn log_graph_impl(cwd: &str, limit: u32) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let limit = limit.clamp(1, 300).to_string();
    let o = git_run(
        &user_git(
            cwd,
            &[
                "log",
                "--topo-order",
                "-n",
                &limit,
                "--branches",
                "--remotes",
                "--no-color",
                "--decorate=full",
                "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ct%x1f%s%x1e",
            ],
        ),
        None,
        &[],
    )?;
    // unborn HEAD：还没有提交，空历史而非报错
    if !o.ok {
        return Ok(json!([]));
    }
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let entries: Vec<Value> = text
        .split('\u{1e}')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let mut it = rec.split('\u{1f}');
            let (Some(hash), Some(parents), Some(decor), Some(author), Some(ct), Some(subject)) = (
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
                it.next(),
            ) else {
                return None;
            };
            Some(json!({
                "hash": hash,
                "parents": parents.split_whitespace().collect::<Vec<_>>(),
                "refs": parse_refs(decor),
                "author": author,
                "time": ct.parse::<i64>().unwrap_or(0) * 1000,
                "subject": subject,
            }))
        })
        .collect();
    Ok(Value::Array(entries))
}

/* ------------------------------ 影子仓库检查点 ------------------------------ */

/// 稳定哈希（FNV-1a 64 位十六进制）：影子仓库目录名，跨重启一致
pub fn fnv1a_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn shadow_dir_for(app: &AppHandle, canon_cwd: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("checkpoints").join(fnv1a_hex(canon_cwd)))
}

/// 首次使用时初始化影子仓库：bare init 后翻回非裸、HEAD 固定 refs/heads/main、
/// 写 info/exclude 兜底忽略规则（快照与 diff/restore 都受它约束）。
fn ensure_shadow(git_dir: &Path) -> Result<(), String> {
    if !git_dir.join("HEAD").exists() {
        std::fs::create_dir_all(git_dir).map_err(|e| format!("failed to create shadow dir: {e}"))?;
        let d = git_dir.to_string_lossy().to_string();
        let o = git_run(&ga(&["init", "-q", "--bare", &d]), None, &[])?;
        if !o.ok {
            return Err(format!("shadow-init-failed: {}", o.stderr));
        }
        for args in [
            ga(&["--git-dir", &d, "config", "core.bare", "false"]),
            ga(&["--git-dir", &d, "symbolic-ref", "HEAD", "refs/heads/main"]),
        ] {
            let o = git_run(&args, None, &[])?;
            if !o.ok {
                return Err(format!("shadow-init-failed: {}", o.stderr));
            }
        }
    }
    // init --bare 会带一个模板 info/exclude，因此不能"不存在才写"；
    // 以 marker 判断，缺失就追加（老版本遗留的影子仓库也会被补齐）
    let info = git_dir.join("info");
    std::fs::create_dir_all(&info).map_err(|e| format!("failed to create shadow info: {e}"))?;
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !existing.contains(SHADOW_EXCLUDE_MARKER) {
        let mut body = existing;
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(SHADOW_EXCLUDE_MARKER);
        body.push('\n');
        body.push_str(SHADOW_EXCLUDES);
        let _ = std::fs::write(&exclude, body);
    }
    Ok(())
}

fn sanitize_tag(tag: &str) -> String {
    let s: String = tag
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut s = s.trim_matches('-').to_string();
    if s.len() > 40 {
        s.truncate(40);
        s = s.trim_matches('-').to_string();
    }
    if s.is_empty() {
        s.push_str("run");
    }
    s
}

/// 检查点 ref 清单：`for-each-ref "%(refname)\t%(objectname)"`，默认按 refname
/// 升序——ref 名以零填充时间戳开头，字典序即时间序。失败返回空表（与旧实现
/// 中 parent 查询失败静默降级一致）。
fn list_checkpoint_refs(dir: &str, work: &str) -> Vec<(String, String)> {
    let o = match git_run(
        &shadow_git(
            dir,
            work,
            &[
                "for-each-ref",
                "--format=%(refname)\t%(objectname)",
                CHECKPOINT_REF_PREFIX,
            ],
        ),
        None,
        &[],
    ) {
        Ok(o) if o.ok => o,
        _ => return Vec::new(),
    };
    // ref 名不含空白，按最后一个 TAB 切
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|line| {
            let (r, h) = line.rsplit_once('\t')?;
            Some((r.to_string(), h.trim().to_string()))
        })
        .collect()
}

/// 打快照 = 影子仓库 add -A + write-tree + commit-tree（不写任何用户仓库状态）。
/// 返回 commit hash；每次都是 ref 链上的独立快照相链（parent 为上一个检查点）。
/// 迭代 3b：① parent 查询与 LRU 清理共用同一份 for-each-ref 结果（此前两次）；
/// ② 工作区与 parent commit 同树（日常对话轮多数零文件改动）时直接复用 parent
/// hash——省一次 commit-tree 子进程，且影子仓库不随空转轮次堆积对象。
fn snapshot_impl(dir: &str, work: &str, tag: &str) -> Result<String, String> {
    let add = git_run(&shadow_git(dir, work, &["add", "-A"]), None, &[])?;
    if !add.ok {
        return Err(format!("snapshot-add-failed: {}", add.stderr));
    }
    let tree = git_run(&shadow_git(dir, work, &["write-tree"]), None, &[])?;
    if !tree.ok {
        return Err(format!("snapshot-tree-failed: {}", tree.stderr));
    }
    let tree = String::from_utf8_lossy(&tree.stdout).trim().to_string();
    let refs_before = list_checkpoint_refs(dir, work);
    let parent = refs_before
        .iter()
        .rev()
        .find_map(|(_, h)| check_hash(h).ok().map(|()| h.clone()));

    // 同树复用：parent 存在且其 tree == 本轮 write-tree ⇒ 复用 parent commit
    let hash = match parent.as_deref() {
        Some(parent) => {
            let spec = format!("{parent}^{{tree}}");
            let pt = git_run(&shadow_git(dir, work, &["rev-parse", &spec]), None, &[])?;
            let parent_tree = if pt.ok {
                String::from_utf8_lossy(&pt.stdout).trim().to_string()
            } else {
                String::new()
            };
            if !tree.is_empty() && parent_tree == tree {
                parent.to_string()
            } else {
                commit_checkpoint_tree(dir, work, &tree, tag, Some(parent))?
            }
        }
        None => commit_checkpoint_tree(dir, work, &tree, tag, None)?,
    };
    // 复用路径的 hash 取自清单且已过 check_hash；新 commit 才需校验输出完整
    if parent.as_deref() != Some(hash.as_str()) {
        check_hash(&hash)?;
    }
    let refname = format!("{CHECKPOINT_REF_PREFIX}/{:011}-{}", now_secs(), sanitize_tag(tag));
    let ur = git_run(
        &shadow_git(dir, work, &["update-ref", &refname, &hash]),
        None,
        &[],
    )?;
    if !ur.ok {
        return Err(format!("snapshot-ref-failed: {}", ur.stderr));
    }
    prune_checkpoints(dir, &refname, refs_before);
    Ok(hash)
}

/// commit-tree 一步的封装：parent 为空时生成根 checkpoint commit
fn commit_checkpoint_tree(
    dir: &str,
    work: &str,
    tree: &str,
    tag: &str,
    parent: Option<&str>,
) -> Result<String, String> {
    let mut cargs: Vec<String> = vec!["commit-tree".into(), tree.into(), "-m".into(), tag.into()];
    if let Some(p) = parent {
        cargs.push("-p".into());
        cargs.push(p.into());
    }
    let idents: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "Xulux Checkpoints"),
        ("GIT_AUTHOR_EMAIL", "checkpoints@xulux.local"),
        ("GIT_COMMITTER_NAME", "Xulux Checkpoints"),
        ("GIT_COMMITTER_EMAIL", "checkpoints@xulux.local"),
    ];
    let commit = git_run(&shadow_git(dir, work, &cargs), None, idents)?;
    if !commit.ok {
        return Err(format!("snapshot-commit-failed: {}", commit.stderr));
    }
    Ok(String::from_utf8_lossy(&commit.stdout).trim().to_string())
}

/// LRU 清理：检查点 ref 按时间戳命名（字典序=时间序），只保留最近 CHECKPOINT_KEEP 个。
/// 迭代 3b：清单由 snapshot_impl 在 commit 前一次枚举后传入（此前这里再跑一遍
/// for-each-ref）；`keep_ref` 是本次新建、尚未出现在清单里的 ref，计数 +1。
fn prune_checkpoints(dir: &str, keep_ref: &str, entries: Vec<(String, String)>) {
    if entries.len() + 1 <= CHECKPOINT_KEEP {
        return;
    }
    let mut doomed = entries.len() + 1 - CHECKPOINT_KEEP;
    for (r, h) in &entries {
        if doomed == 0 {
            break;
        }
        if r == keep_ref {
            continue;
        }
        doomed -= 1;
        let _ = git_run(&shadow_git(dir, ".", &["update-ref", "-d", r]), None, &[]);
        let _ = std::fs::remove_file(patch_file_path(dir, h));
    }
    // 删掉不可达对象（--auto 尊重阈值，小仓库基本 no-op）
    let _ = git_run(&shadow_git(dir, ".", &["gc", "--auto", "--quiet"]), None, &[]);
}

/// 解析 `git diff --name-status -z`：状态、路径交替；R/C 多带一个原路径
fn parse_name_status_z(raw: &[u8]) -> Vec<(String, Option<String>, String)> {
    let text = String::from_utf8_lossy(raw).to_string();
    let recs: Vec<&str> = text.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < recs.len() {
        let status = recs[i];
        i += 1;
        if status.is_empty() {
            continue;
        }
        let c = status.chars().next().unwrap_or('M');
        if matches!(c, 'R' | 'C') {
            if i + 1 >= recs.len() {
                break;
            }
            let old = recs[i].to_string();
            let new = recs[i + 1].to_string();
            i += 2;
            out.push((c.to_string(), Some(old), new));
        } else if i < recs.len() {
            let path = recs[i].to_string();
            i += 1;
            out.push((c.to_string(), None, path));
        }
    }
    out
}

/// 运行结束时刻的全量反向 patch 落盘位置（restore 优先用它，才能做出
/// "finish 后用户又改过 → apply-conflict" 的中止语义；实时重算的 diff
/// 永远能干净地反向应用，起不到保护作用）。
fn patch_file_path(dir: &str, hash: &str) -> PathBuf {
    Path::new(dir)
        .join("xulux-patches")
        .join(format!("{hash}.patch"))
}

fn checkpoint_files_impl(dir: &str, work: &str, hash: &str) -> Result<Value, String> {
    let add = git_run(&shadow_git(dir, work, &["add", "-A"]), None, &[])?;
    if !add.ok {
        return Err(format!("snapshot-stage-failed: {}", add.stderr));
    }
    // 顺带持久化"当前时刻"的全量 binary diff（restore 的回放依据）
    if let Ok(d) = git_run(
        &shadow_git(
            dir,
            work,
            &["diff", hash, "--binary", "--no-color", "--no-ext-diff"],
        ),
        None,
        &[],
    ) {
        if d.ok && d.stdout.len() <= MAX_PATCH_FILE_BYTES {
            let pf = patch_file_path(dir, hash);
            if let Some(parent) = pf.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&pf, &d.stdout);
        }
    }
    let ns = git_run(
        &shadow_git(dir, work, &["diff", hash, "--name-status", "-z"]),
        None,
        &[],
    )?;
    if !ns.ok {
        return Err(format!("snapshot-diff-failed: {}", ns.stderr));
    }
    let list = parse_name_status_z(&ns.stdout);
    let mut files: Vec<Value> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    for (status, old, path) in list {
        if files.len() >= MAX_DIFF_FILES {
            truncated = true;
            break;
        }
        let entry = |patch: String, added: u32, removed: u32, binary: bool| {
            json!({
                "path": path, "oldPath": old, "status": status, "staged": false,
                "added": added, "removed": removed, "binary": binary, "patch": patch,
            })
        };
        if total > MAX_DIFF_TOTAL_BYTES {
            truncated = true;
            files.push(entry(String::new(), 0, 0, false));
            continue;
        }
        let mut rest: Vec<String> = vec![
            "diff".into(),
            hash.into(),
            "--no-color".into(),
            "--unified=3".into(),
            "--no-ext-diff".into(),
            "--".into(),
            format!(":(literal){path}"),
        ];
        if let Some(o) = &old {
            rest.push(format!(":(literal){o}"));
        }
        let d = git_run(&shadow_git(dir, work, &rest), None, &[]).unwrap_or(GitOut {
            ok: false,
            stdout: Vec::new(),
            stderr: String::new(),
        });
        if !d.ok {
            files.push(entry(String::new(), 0, 0, false));
            continue;
        }
        let (patch, capped) = cap_patch_chars(String::from_utf8_lossy(&d.stdout).to_string());
        let (added, removed, binary) = patch_stats(&patch);
        total += patch.len();
        truncated |= capped;
        files.push(entry(patch, added, removed, binary));
    }
    Ok(json!({ "files": files, "truncated": truncated }))
}

/// 撤销：反向 `git apply -R` 把工作区放回快照。
/// 优先回放 checkpoint_files_impl 在"运行结束时刻"落盘的 patch：
/// finish 后用户再手改过相关文件时，--check 会失配 → apply-conflict，绝不部分覆盖。
/// 无存档 patch（异常路径）才退回"实时 diff <hash>"（等价于放弃冲突保护）。
fn restore_impl(dir: &str, work: &str, hash: &str) -> Result<(), String> {
    let pf = patch_file_path(dir, hash);
    let stored: Option<Vec<u8>> = std::fs::read(&pf).ok();
    let patch: Vec<u8> = match stored {
        Some(p) => p,
        None => {
            let add = git_run(&shadow_git(dir, work, &["add", "-A"]), None, &[])?;
            if !add.ok {
                return Err(format!("snapshot-stage-failed: {}", add.stderr));
            }
            let d = git_run(
                &shadow_git(
                    dir,
                    work,
                    &["diff", hash, "--binary", "--no-color", "--no-ext-diff"],
                ),
                None,
                &[],
            )?;
            if !d.ok {
                return Err(format!("snapshot-diff-failed: {}", d.stderr));
            }
            d.stdout
        }
    };
    if patch.is_empty() {
        let _ = std::fs::remove_file(&pf);
        return Ok(()); // 快照后无任何改动
    }
    let check = git_run(
        &user_git(work, &["apply", "-R", "--check", "--binary", "--allow-empty"]),
        Some(&patch),
        &[],
    )?;
    if !check.ok {
        return Err(format!("apply-conflict: {}", check.stderr));
    }
    let ap = git_run(
        &user_git(work, &["apply", "-R", "--binary", "--allow-empty"]),
        Some(&patch),
        &[],
    )?;
    if !ap.ok {
        return Err(format!("apply-failed: {}", ap.stderr));
    }
    let _ = std::fs::remove_file(&pf);
    Ok(())
}

/* ------------------------------ stage / commit / branch ------------------------------ */

fn literal_pathspecs(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| format!(":(literal){p}"))
        .collect()
}

fn stage_impl(cwd: &str, paths: &[String], on: bool) -> Result<(), String> {
    ensure_repo(cwd)?;
    let rest: Vec<String> = if paths.is_empty() {
        if on {
            vec!["add".into(), "-A".into()]
        } else {
            vec!["reset".into(), "-q".into()]
        }
    } else {
        let mut v: Vec<String> = if on {
            vec!["add".into(), "--".into()]
        } else {
            vec!["reset".into(), "-q".into(), "--".into()]
        };
        v.extend(literal_pathspecs(paths));
        v
    };
    let o = git_run(&user_git(cwd, &rest), None, &[])?;
    if !o.ok {
        return Err(format!("git-stage-failed: {}", o.stderr));
    }
    Ok(())
}

fn commit_impl(cwd: &str, message: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    if message.trim().is_empty() {
        return Err("empty-message".into());
    }
    let o = git_run(
        &user_git(cwd, &["commit", "-q", "--no-verify", "-F", "-"]),
        Some(message.as_bytes()),
        &[],
    )?;
    if !o.ok {
        return Err(format!("git-commit-failed: {}", o.stderr));
    }
    let h = git_run(&user_git(cwd, &["rev-parse", "HEAD"]), None, &[])?;
    let hash = String::from_utf8_lossy(&h.stdout).trim().to_string();
    Ok(json!({ "hash": hash }))
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && !name.starts_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.contains("@{")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c));
    if ok {
        Ok(())
    } else {
        Err("bad-branch-name".into())
    }
}

fn branches_impl(cwd: &str) -> Result<Value, String> {
    ensure_repo(cwd)?;
    let sym = git_run(
        &user_git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]),
        None,
        &[],
    )?;
    let current = if sym.ok {
        Some(String::from_utf8_lossy(&sym.stdout).trim().to_string())
    } else {
        None
    };
    let o = git_run(
        &user_git(
            cwd,
            &[
                "for-each-ref",
                "refs/heads",
                "--format=%(refname:short)%1f%(upstream:short)",
            ],
        ),
        None,
        &[],
    )?;
    if !o.ok {
        return Err(format!("git-branch-failed: {}", o.stderr));
    }
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let branches: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            let mut it = line.split('\u{1f}');
            let name = it.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let upstream = it.next().filter(|s| !s.is_empty()).map(|s| s.to_string());
            Some(json!({
                "name": name,
                "current": Some(&name) == current.as_ref(),
                "upstream": upstream,
            }))
        })
        .collect();
    Ok(json!({
        "current": current,
        "detached": current.is_none(),
        "branches": branches,
    }))
}

fn checkout_impl(cwd: &str, name: &str, create: bool) -> Result<(), String> {
    ensure_repo(cwd)?;
    validate_branch_name(name)?;
    let mut rest: Vec<String> = vec!["checkout".into(), "-q".into()];
    if create {
        rest.push("-b".into());
    }
    rest.push(name.into());
    let o = git_run(&user_git(cwd, &rest), None, &[])?;
    if !o.ok {
        return Err(format!("git-checkout-failed: {}", o.stderr));
    }
    Ok(())
}

/* ------------------------------ Tauri 命令 ------------------------------ */

async fn spawn_git<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task join error: {e}"))?
}

#[tauri::command]
pub async fn git_probe() -> Result<Value, String> {
    spawn_git(|| {
        Ok(json!({
            "available": git_version().is_some(),
            "version": git_version(),
        }))
    })
    .await
}

#[tauri::command]
pub async fn git_status(app: AppHandle, cwd: String) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        status_impl(&r.run)
    })
    .await
}

/// opts.checkpoint = Some(hash) 时对比该检查点（影子仓库），否则对比 HEAD
#[tauri::command]
pub async fn git_diff(
    app: AppHandle,
    cwd: String,
    checkpoint: Option<String>,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        ensure_repo(&r.run)?;
        match checkpoint {
            Some(h) => {
                check_hash(&h)?;
                let sd = shadow_dir_for(&app, &r.key)?;
                if !sd.join("HEAD").exists() {
                    return Err("no-checkpoint".into());
                }
                let e = git_run(
                    &ga(&[
                        "--git-dir",
                        &sd.to_string_lossy(),
                        "cat-file",
                        "-e",
                        &format!("{h}^{{commit}}"),
                    ]),
                    None,
                    &[],
                )?;
                if !e.ok {
                    return Err("no-checkpoint".into());
                }
                checkpoint_files_impl(&sd.to_string_lossy(), &r.run, &h)
            }
            None => diff_head_impl(&r.run),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_show(
    app: AppHandle,
    cwd: String,
    reference: String,
    path: String,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        show_impl(&r.run, &reference, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_worktree_read(
    app: AppHandle,
    cwd: String,
    path: String,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        worktree_read_impl(&r.run, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_log(app: AppHandle, cwd: String, limit: Option<u32>) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        log_impl(&r.run, limit.unwrap_or(50))
    })
    .await
}

#[tauri::command]
pub async fn git_log_graph(
    app: AppHandle,
    cwd: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        log_graph_impl(&r.run, limit.unwrap_or(200))
    })
    .await
}

#[tauri::command]
pub async fn git_checkpoint_create(
    app: AppHandle,
    cwd: String,
    tag: String,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        ensure_repo(&r.run)?;
        let sd = shadow_dir_for(&app, &r.key)?;
        let run = r.run.clone();
        let hash = with_cwd_lock(&r.key, || -> Result<String, String> {
            ensure_shadow(&sd)?;
            snapshot_impl(&sd.to_string_lossy(), &run, &tag)
        })?;
        emit_changed(&app, &r.run);
        Ok(json!({ "hash": hash }))
    })
    .await
}

#[tauri::command]
pub async fn git_checkpoint_restore(
    app: AppHandle,
    cwd: String,
    hash: String,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        ensure_repo(&r.run)?;
        check_hash(&hash)?;
        let sd = shadow_dir_for(&app, &r.key)?;
        if !sd.join("HEAD").exists() {
            return Err("no-checkpoint".into());
        }
        with_cwd_lock(&r.key, || restore_impl(&sd.to_string_lossy(), &r.run, &hash))?;
        emit_changed(&app, &r.run);
        Ok(json!({ "restored": true }))
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    app: AppHandle,
    cwd: String,
    paths: Vec<String>,
    on: bool,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        with_cwd_lock(&r.key, || stage_impl(&r.run, &paths, on))?;
        emit_changed(&app, &r.run);
        Ok(json!({ "ok": true }))
    })
    .await
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, cwd: String, message: String) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        let res = with_cwd_lock(&r.key, || commit_impl(&r.run, &message))?;
        emit_changed(&app, &r.run);
        Ok(res)
    })
    .await
}

#[tauri::command]
pub async fn git_branches(app: AppHandle, cwd: String) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        branches_impl(&r.run)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(
    app: AppHandle,
    cwd: String,
    name: String,
    create: bool,
) -> Result<Value, String> {
    spawn_git(move || {
        let r = resolve_workspace(&app, &cwd)?;
        with_cwd_lock(&r.key, || checkout_impl(&r.run, &name, create))?;
        emit_changed(&app, &r.run);
        Ok(json!({ "ok": true }))
    })
    .await
}

/* ------------------------------ 测试 ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn need_git() -> bool {
        git_version().is_some()
    }

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-git-{}-{}-{tag}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();
        for args in [
            ga(&["-C", &p, "init", "-q", "-b", "main"]),
            ga(&["-C", &p, "config", "user.email", "t@t"]),
            ga(&["-C", &p, "config", "user.name", "t"]),
        ] {
            let o = git_run(&args, None, &[]).unwrap();
            assert!(o.ok, "{:?}", o.stderr);
        }
        dir
    }

    #[test]
    fn parse_status_v2_branch_and_files() {
        // 构造与 `git status --porcelain=v2 --branch -z` 相同的字节布局
        let raw = "# branch.oid 9a6d4a57\u{0}\
                   # branch.head main\u{0}\
                   # branch.upstream origin/main\u{0}\
                   # branch.ab +1 -2\u{0}\
                   2 RM N... 100644 100644 100644 aaa bbb R100 new.txt\u{0}\
                   old name.txt\u{0}\
                   1 .M N... 100644 100644 100644 ccc ddd sub/f2.txt\u{0}\
                   ? new.txt\u{0}"
            .as_bytes()
            .to_vec();
        let p = parse_status_v2(&raw);
        assert_eq!(p.head, "main");
        assert_eq!(p.upstream.as_deref(), Some("origin/main"));
        assert_eq!((p.ahead, p.behind), (1, 2));
        assert_eq!(p.files.len(), 3);
        let ren = &p.files[0];
        assert_eq!(ren.kind, 'R');
        assert!(ren.staged);
        assert_eq!(ren.old_path.as_deref(), Some("old name.txt"));
        assert_eq!(p.files[1].kind, 'M');
        assert!(!p.files[1].staged); // XY=.M → 索引位无变更（仅工作区修改）
        assert_eq!(p.files[2].kind, '?');
    }

    #[test]
    fn patch_stats_counts_hunk_lines_only() {
        let patch = "diff --git a/x b/x\n\
                     index abc..def 100644\n\
                     --- a/x\n\
                     +++ b/x\n\
                     @@ -1,3 +1,3 @@\n\
                     ctx\n\
                     -gone\n\
                     +-added\n\
                     +plus2\n";
        let (a, r, bin) = patch_stats(patch);
        assert_eq!((a, r, bin), (2, 1, false));
        assert_eq!(patch_stats("Binary files a and b differ").2, true);
    }

    #[test]
    fn parse_refs_decorations() {
        // %D 实测输出不带括号；%d 形式（带括号）也要能解析
        let r = parse_refs("HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0");
        assert_eq!(r.len(), 4); // HEAD -> branch 拆出 head + branch 两条
        assert_eq!((r[0]["name"].as_str().unwrap(), r[0]["kind"].as_str().unwrap()), ("HEAD", "head"));
        assert_eq!((r[1]["name"].as_str().unwrap(), r[1]["kind"].as_str().unwrap()), ("main", "branch"));
        assert_eq!((r[2]["name"].as_str().unwrap(), r[2]["kind"].as_str().unwrap()), ("origin/main", "remote"));
        assert_eq!((r[3]["name"].as_str().unwrap(), r[3]["kind"].as_str().unwrap()), ("v1.0", "tag"));
        let p = parse_refs("(HEAD -> refs/heads/feat/x)");
        assert_eq!(p[1]["name"], "feat/x");
        assert!(parse_refs("").is_empty());
        assert!(parse_refs("HEAD detached at 1a2b3c4").iter().any(|x| x["kind"] == "head"));
    }

    #[test]
    fn log_graph_branch_merge_and_refs() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("graph");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "init"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["checkout", "-q", "-b", "side"]), None, &[]).unwrap();
        std::fs::write(dir.join("s.txt"), "s\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "side work"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["checkout", "-q", "main"]), None, &[]).unwrap();
        std::fs::write(dir.join("m.txt"), "m\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "main work"]), None, &[]).unwrap();
        let o = git_run(
            &user_git(&p, &["merge", "-q", "--no-ff", "side", "-m", "merge side"]),
            None,
            &[],
        )
        .unwrap();
        assert!(o.ok, "{:?}", o.stderr);
        git_run(&user_git(&p, &["tag", "v1"]), None, &[]).unwrap();

        let v = log_graph_impl(&p, 50).unwrap();
        let rows = v.as_array().unwrap();
        assert_eq!(rows.len(), 4, "{rows:?}");
        // 拓扑序首行是合并提交：两个父
        assert_eq!(rows[0]["subject"], "merge side");
        assert_eq!(rows[0]["parents"].as_array().unwrap().len(), 2);
        let kinds: Vec<&str> = rows[0]["refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["kind"].as_str().unwrap())
            .collect();
        assert!(kinds.contains(&"head") && kinds.contains(&"branch") && kinds.contains(&"tag"), "{kinds:?}");
        // side 分支尖仍指向第二行的提交
        assert!(rows[1]["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["name"] == "side" && x["kind"] == "branch"));
        // 根提交无父
        assert_eq!(rows[3]["subject"], "init");
        assert_eq!(rows[3]["parents"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_untracked_and_head() {
        if !need_git() {
            eprintln!("skip: git not installed");
            return;
        }
        let dir = tmp_repo("status");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "init"]), None, &[]).unwrap();
        std::fs::write(dir.join("b.txt"), "untracked\n").unwrap();
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        let v = status_impl(&p).unwrap();
        assert_eq!(v["branch"], "main");
        assert_eq!(v["dirty"], 2);
        assert_eq!(v["lastCommit"]["subject"], "init");
        let paths: Vec<&str> = v["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"a.txt") && paths.contains(&"b.txt"), "{paths:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_head_includes_bash_edited_files() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("diff");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "k\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "init"]), None, &[]).unwrap();
        std::fs::write(dir.join("a.txt"), "1\nX\n3\nnew\n").unwrap();
        std::fs::write(dir.join("n.txt"), "brand new\nfile\n").unwrap();
        let v = diff_head_impl(&p).unwrap();
        let files = v["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let tracked = &files[0];
        assert_eq!(tracked["added"], 2);
        assert_eq!(tracked["removed"], 1);
        let untracked = files.iter().find(|f| f["status"] == "?").unwrap();
        assert_eq!(untracked["added"], 2);
        assert!(untracked["patch"].as_str().unwrap().contains("+++ b/n.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checkpoint_snapshot_diff_and_restore_roundtrip() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("checkpoint");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "1\n2\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/x.js"), "junk\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "init"]), None, &[]).unwrap();

        let shadow = dir.parent().unwrap().join(format!("shadow-{}-checkpoint", std::process::id()));
        let _ = std::fs::remove_dir_all(&shadow);
        ensure_shadow(&shadow).unwrap();
        let s = shadow.to_string_lossy().to_string();
        let hash = snapshot_impl(&s, &p, "run-1").unwrap();
        assert!(check_hash(&hash).is_ok());

        // agent 改动：改文件、删文件、新建文件；快照对比都应列出
        std::fs::write(dir.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::remove_file(dir.join(".gitignore")).unwrap();
        std::fs::write(dir.join("b.txt"), "created\n").unwrap();
        let v = checkpoint_files_impl(&s, &p, &hash).unwrap();
        let files = v["files"].as_array().unwrap();
        let by: HashMap<&str, &str> = files
            .iter()
            .map(|f| (f["path"].as_str().unwrap(), f["status"].as_str().unwrap()))
            .collect();
        assert_eq!(by.get("a.txt"), Some(&"M"));
        assert_eq!(by.get("b.txt"), Some(&"A"));
        assert_eq!(by.get(".gitignore"), Some(&"D"));
        // 被 .gitignore 排除的 node_modules 不进快照差异
        assert!(!by.contains_key("node_modules/pkg/x.js"), "{by:?}");

        restore_impl(&s, &p, &hash).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "1\n2\n");
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), "node_modules/\n");
        assert!(!dir.join("b.txt").exists());
        assert!(dir.join("node_modules/pkg/x.js").exists()); // 真实安装目录未被还原波及

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 迭代 3b：同树复用——工作区无改动的轮次不再产生新 commit，
    /// ref 时间线照常（每次快照一个 ref），restore 语义不受影响
    #[test]
    fn checkpoint_tree_reuse_skips_empty_commits() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("checkpoint-reuse");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        let shadow = dir
            .parent()
            .unwrap()
            .join(format!("shadow-{}-checkpoint-reuse", std::process::id()));
        let _ = std::fs::remove_dir_all(&shadow);
        ensure_shadow(&shadow).unwrap();
        let s = shadow.to_string_lossy().to_string();

        let h1 = snapshot_impl(&s, &p, "run-1").unwrap();
        // 无文件改动：第二个 ref 复用同一 commit（影子仓库零新对象）
        let h2 = snapshot_impl(&s, &p, "run-2").unwrap();
        assert_eq!(h1, h2, "同树快照应复用上一 hash");
        let refs = list_checkpoint_refs(&s, &p);
        assert_eq!(refs.len(), 2, "复用不应吞掉 ref 时间线");

        // 有改动：产生新 commit；连续第二次空轮继续复用新树
        std::fs::write(dir.join("b.txt"), "2\n").unwrap();
        let h3 = snapshot_impl(&s, &p, "run-3").unwrap();
        assert_ne!(h2, h3);
        let h4 = snapshot_impl(&s, &p, "run-4").unwrap();
        assert_eq!(h3, h4, "改动后的空轮应复用改动快照的 hash");

        // 回滚到复用链上的 h1（早于 b.txt 出现）：reverse-apply 应删掉 b.txt
        restore_impl(&s, &p, &h1).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "1\n");
        assert!(!dir.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_aborts_on_conflict() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("conflict");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        git_run(&user_git(&p, &["add", "-A"]), None, &[]).unwrap();
        git_run(&user_git(&p, &["commit", "-q", "-m", "init"]), None, &[]).unwrap();
        let shadow = dir.parent().unwrap().join(format!("shadow-{}-conflict", std::process::id()));
        let _ = std::fs::remove_dir_all(&shadow);
        ensure_shadow(&shadow).unwrap();
        let s = shadow.to_string_lossy().to_string();
        let hash = snapshot_impl(&s, &p, "run").unwrap();
        // agent 改动文件，运行结束时刻做 checkpoint diff（同时持久化反向 patch）
        std::fs::write(dir.join("a.txt"), "one\nTWO-by-agent\nthree\nfour\nfive\nsix\n").unwrap();
        checkpoint_files_impl(&s, &p, &hash).unwrap();
        // finish 之后用户又手改了同一文件 → 回放存档 patch 必然上下文失配
        std::fs::write(dir.join("a.txt"), "totally rewritten\nby user\n").unwrap();
        let err = restore_impl(&s, &p, &hash).unwrap_err();
        assert!(err.starts_with("apply-conflict"), "{err}");
        // 冲突时未动工作区
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "totally rewritten\nby user\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_commit_and_log_flow() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("commit");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        stage_impl(&p, &["a.txt".to_string()], true).unwrap();
        let v = status_impl(&p).unwrap();
        assert_eq!(v["files"][0]["staged"], true);
        let c = commit_impl(&p, "feat: add a").unwrap();
        assert!(check_hash(c["hash"].as_str().unwrap()).is_ok());
        let log = log_impl(&p, 10).unwrap();
        let arr = log.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["subject"], "feat: add a");
        // 取消暂存路径：stage 再 unstage
        std::fs::write(dir.join("b.txt"), "x\n").unwrap();
        stage_impl(&p, &["b.txt".to_string()], true).unwrap();
        stage_impl(&p, &["b.txt".to_string()], false).unwrap();
        let v = status_impl(&p).unwrap();
        let b = v["files"].as_array().unwrap().iter().find(|f| f["path"] == "b.txt").unwrap();
        assert_eq!(b["staged"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_and_checkout() {
        if !need_git() {
            return;
        }
        let dir = tmp_repo("branch");
        let p = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "x\n").unwrap();
        stage_impl(&p, &[], true).unwrap();
        commit_impl(&p, "init").unwrap();
        let b = branches_impl(&p).unwrap();
        assert_eq!(b["current"], "main");
        assert_eq!(b["branches"].as_array().unwrap().len(), 1);
        checkout_impl(&p, "dev", true).unwrap();
        let b = branches_impl(&p).unwrap();
        assert_eq!(b["current"], "dev");
        assert_eq!(b["branches"].as_array().unwrap().len(), 2);
        checkout_impl(&p, "main", false).unwrap();
        assert_eq!(branches_impl(&p).unwrap()["current"], "main");
        assert!(validate_branch_name("-u").is_err());
        assert!(validate_branch_name("..").is_err());
        assert!(validate_branch_name("feature/x_1").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fnv1a_is_stable() {
        assert_eq!(fnv1a_hex("/a/b"), fnv1a_hex("/a/b"));
        assert_ne!(fnv1a_hex("/a/b"), fnv1a_hex("/a/c"));
    }

    #[test]
    fn reference_and_hash_validation() {
        assert!(check_reference("HEAD").is_ok());
        assert!(check_reference("HEAD~2").is_ok());
        assert!(check_reference("feature/x").is_ok());
        assert!(check_reference("--output=/tmp/x").is_err());
        assert!(check_reference("").is_err());
        assert!(check_hash("9a6d4a57").is_ok());
        assert!(check_hash("$(rm -rf)").is_err());
    }
}
